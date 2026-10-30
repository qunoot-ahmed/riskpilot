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
