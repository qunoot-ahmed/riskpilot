import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AnalysisResult } from "../src/types.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function write(repo: string, path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function git(repo: string, ...args: string[]) {
  execFileSync("git", ["-C", repo, "-c", "user.name=RiskPilot", "-c", "user.email=test@example.invalid", ...args]);
}

function riskpilot(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("riskpilot CLI", () => {
  let repo = "";

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "riskpilot-e2e-"));
    git(repo, "init", "--quiet");
    write(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
    write(repo, "src/price.ts", "export const price = 1;\n");
    write(repo, "src/cart.ts", 'import { price } from "@/price";\nexport const total = price;\n');
    write(repo, "src/page.tsx", "export default function Page() { return null; }\n");
    write(repo, "src/cart.test.ts", 'import { it } from "vitest";\nimport { total } from "./cart";\n');
    write(repo, "tests/e2e/page.spec.ts", 'import { test } from "@playwright/test";\n');
    write(
      repo,
      "riskpilot.config.json",
      JSON.stringify({ mappings: [{ name: "Page", changed: "src/page.tsx", tests: "tests/e2e/**", reason: "visits the page" }] }),
    );
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "base");
    git(repo, "tag", "base");

    write(repo, "src/price.ts", "export const price = 2;\n");
    write(repo, "src/page.tsx", "export default function Page() { return 1; }\n");
    write(repo, "README.md", "# changed docs\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "change");
    git(repo, "tag", "selective");

    write(repo, "package.json", "{}\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "dependency change");
  });

  it("prints a selective text summary with reasons", () => {
    const result = riskpilot(repo, "base", "selective");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Decision: SELECTIVE, run 2 of 2 test files/);
    assert.match(result.stdout, /imports src\/price\.ts through src\/cart\.ts/);
    assert.match(result.stdout, /mapping "Page": visits the page \(src\/page\.tsx\)/);
    assert.match(result.stdout, /ignored: matches ignore pattern "\*\.md"/);
  });

  it("writes JSON and falls back to the full suite for a package.json change", () => {
    const output = join(repo, "..", `riskpilot-${Date.now()}.json`);
    const result = riskpilot(repo, "selective", "HEAD", "--json", "--output", output);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as AnalysisResult;
    assert.equal(json.mode, "full-suite");
    assert.deepEqual(json.fallbackReasons, ['package.json matches full suite trigger "package.json"']);
    assert.equal(json.selectedTests.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), json);
  });

  it("reports unknown revisions and missing arguments", () => {
    const unknown = riskpilot(repo, "no-such-branch");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown revision "no-such-branch"/);
    assert.equal(riskpilot(repo).status, 2);
  });
});

describe("riskpilot CLI in CI observation mode", () => {
  let repo = "";
  let forkPoint = "";
  const sha = (ref: string) => execFileSync("git", ["-C", repo, "rev-parse", ref]).toString().trim();

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "riskpilot-ci-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    write(repo, "package.json", JSON.stringify({ devDependencies: { vitest: "5", "@playwright/test": "1" } }));
    write(repo, "src/price.ts", "export const price = 1;\n");
    write(repo, "src/price.test.ts", 'import { it } from "vitest";\nimport { price } from "./price";\n');
    write(repo, "src/other.test.ts", 'import { it } from "vitest";\n');
    write(repo, "tests/visual/__screenshots__/home.png", "png");
    write(
      repo,
      "riskpilot.config.json",
      JSON.stringify({ mappings: [{ name: "Shots", changed: "tests/visual/__screenshots__/**", tests: "src/other.test.ts" }] }),
    );
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "base");
    forkPoint = sha("HEAD");

    git(repo, "switch", "--quiet", "-c", "feature");
    write(repo, "src/price.ts", "export const price = 2;\n");
    git(repo, "commit", "--quiet", "-am", "feature change");

    // main moves on after the branch point with a change that would force the full suite.
    git(repo, "switch", "--quiet", "main");
    write(repo, "package.json", JSON.stringify({ devDependencies: { vitest: "6", "@playwright/test": "1" } }));
    git(repo, "commit", "--quiet", "-am", "dependency bump on main");

    git(repo, "switch", "--quiet", "-c", "bad-config", "feature");
    write(repo, "riskpilot.config.json", "{ not json");
    git(repo, "commit", "--quiet", "-am", "broken config");
    git(repo, "switch", "--quiet", "main");
  });

  it("compares a pull request from the merge base, not from the moved base branch", () => {
    const direct = JSON.parse(riskpilot(repo, "main", "feature", "--json").stdout) as AnalysisResult;
    assert.equal(direct.mode, "full-suite");

    const result = riskpilot(repo, "main", "feature", "--merge-base", "--json");
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as AnalysisResult;
    assert.equal(json.status, "ok");
    assert.equal(json.comparison, "merge-base");
    assert.equal(json.base, forkPoint);
    assert.equal(json.mode, "selective");
    assert.deepEqual(
      json.selectedTests.map((test) => test.path),
      ["src/price.test.ts"],
    );
  });

  it("writes a Markdown summary that reports selected versus total without claiming savings", () => {
    const markdown = join(repo, "..", `riskpilot-${Date.now()}.md`);
    const result = riskpilot(repo, "main", "feature", "--merge-base", "--markdown", markdown);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(markdown, "utf8");
    assert.match(text, /observation mode/);
    assert.match(text, /\*\*Recommendation:\*\* 1 of 2 test files selected\./);
    assert.match(text, /\*\*Compared:\*\* merge base [0-9a-f]{7} with head/);
    assert.match(text, /\| src\/price\.test\.ts \| vitest \| imports src\/price\.ts directly \|/);
    assert.match(text, /no time is saved/);
    assert.doesNotMatch(text, /`/);
  });

  it("explains a full suite fallback in the Markdown summary", () => {
    const markdown = join(repo, "..", `riskpilot-${Date.now()}-full.md`);
    assert.equal(riskpilot(repo, forkPoint, "main", "--markdown", markdown).status, 0);
    const text = readFileSync(markdown, "utf8");
    assert.match(text, /\*\*Recommendation:\*\* full suite fallback, all 2 test files\./);
    assert.match(text, /### Why the full suite is needed\n\n- package\.json matches full suite trigger "package\.json"/);
  });

  it("reports an invalid config as a failed analysis, never as a selection", () => {
    const output = join(repo, "..", `riskpilot-${Date.now()}-error.json`);
    const markdown = `${output}.md`;
    const result = riskpilot(repo, "main", "bad-config", "--merge-base", "--output", output, "--markdown", markdown);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not read config riskpilot\.config\.json at [0-9a-f]{7}/);
    const json = JSON.parse(readFileSync(output, "utf8")) as { status: string; error: string; selectedTests?: unknown };
    assert.equal(json.status, "error");
    assert.match(json.error, /Could not read config/);
    assert.equal(json.selectedTests, undefined);
    assert.match(readFileSync(markdown, "utf8"), /\*\*Analysis failed\.\*\* No test recommendation was made\./);
  });

  it("fails clearly when the revisions share no history", () => {
    git(repo, "switch", "--quiet", "--orphan", "unrelated");
    write(repo, "orphan.txt", "x");
    git(repo, "add", "orphan.txt");
    git(repo, "commit", "--quiet", "-m", "unrelated root");
    git(repo, "switch", "--quiet", "main");
    const result = riskpilot(repo, "main", "unrelated", "--merge-base");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No merge base between/);
  });
});
