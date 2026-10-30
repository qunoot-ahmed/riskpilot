import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { defaultConfig } from "../src/config.ts";
import { toText } from "../src/report.ts";
import type { ChangedFile, Config, Mapping } from "../src/types.ts";

// A tiny project: one unit test reaches money.ts through cart.ts, one e2e test only visits a page.
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ devDependencies: { vitest: "5", "@playwright/test": "1" } }),
  "README.md": "# demo",
  "src/money.ts": "export const cents = (n: number) => n * 100;",
  "src/cart.ts": 'import { cents } from "./money";\nexport const total = () => cents(1);',
  "src/orphan.ts": "export const unused = 1;",
  "src/app/page.tsx": 'import { total } from "@/cart";\nexport default () => total();',
  "src/app/styles.css": "body {}",
  "src/cart.test.ts": 'import { it } from "vitest";\nimport { total } from "./cart";',
  "tests/e2e/checkout.spec.ts": 'import { test } from "@playwright/test";\nimport { login } from "./support";',
  "tests/e2e/support.ts": "export const login = () => {};",
  "src/broken.ts": 'import "./gone";',
};

const PAGE_MAPPING: Mapping = {
  name: "Checkout page",
  changed: ["src/app/**"],
  tests: ["tests/e2e/checkout.spec.ts"],
  reason: "the e2e test visits the checkout page",
};

function run(
  changes: ChangedFile[],
  configure: (config: Config) => void = () => {},
  extraFiles: Record<string, string> = {},
) {
  const files = { ...FILES, ...extraFiles };
  const config = defaultConfig();
  config.aliases = { "@/*": ["src/*"] };
  configure(config);
  return analyze({
    repository: "/repo",
    base: "a".repeat(40),
    head: "b".repeat(40),
    changes,
    snapshot: { paths: Object.keys(files), contents: new Map(Object.entries(files)) },
    config,
  });
}

const modified = (path: string): ChangedFile => ({ path, status: "modified" });
const selectedPaths = (result: ReturnType<typeof run>) => result.selectedTests.map((test) => test.path);

describe("analyze", () => {
  it("discovers tests and detects their framework", () => {
    const result = run([]);
    assert.equal(result.totalTests, 2);
    assert.equal(result.mode, "selective");
    assert.deepEqual(result.selectedTests, []);
  });

  it("selects tests that import a changed file transitively and explains the chain", () => {
    const result = run([modified("src/money.ts")]);
    assert.equal(result.mode, "selective");
    assert.deepEqual(selectedPaths(result), ["src/cart.test.ts"]);
    assert.deepEqual(result.selectedTests[0]?.reasons, ["imports src/money.ts through src/cart.ts"]);
    assert.equal(result.selectedTests[0]?.framework, "vitest");
  });

  it("selects a changed test file and tests that import a changed helper", () => {
    const result = run([modified("src/cart.test.ts"), modified("tests/e2e/support.ts")]);
    assert.deepEqual(selectedPaths(result), ["src/cart.test.ts", "tests/e2e/checkout.spec.ts"]);
    assert.deepEqual(result.selectedTests[1]?.reasons, ["imports tests/e2e/support.ts directly"]);
  });

  it("uses explicit mappings for files that tests reach without imports", () => {
    const result = run([modified("src/app/page.tsx")], (config) => config.mappings.push(PAGE_MAPPING));
    assert.equal(result.mode, "selective");
    assert.deepEqual(selectedPaths(result), ["tests/e2e/checkout.spec.ts"]);
    assert.match(result.selectedTests[0]?.reasons[0] ?? "", /mapping "Checkout page"/);
  });

  it("ignores documentation changes", () => {
    const result = run([modified("README.md")]);
    assert.equal(result.mode, "selective");
    assert.equal(result.changedFiles[0]?.outcome, "ignored");
    assert.deepEqual(result.selectedTests, []);
  });

  it("falls back to the full suite for a full suite trigger", () => {
    const result = run([modified("package.json"), modified("src/money.ts")]);
    assert.equal(result.mode, "full-suite");
    assert.equal(result.selectedTests.length, 2);
    assert.match(result.fallbackReasons[0] ?? "", /package\.json matches full suite trigger/);
    // Precise reasons are kept even in a full run.
    assert.deepEqual(result.selectedTests[1]?.reasons, ["full suite fallback"]);
  });

  it("falls back when a code file is reached by no test and no mapping", () => {
    const result = run([modified("src/orphan.ts")]);
    assert.equal(result.mode, "full-suite");
    assert.match(result.fallbackReasons[0] ?? "", /no test imports it and no mapping covers it/);
  });

  it("falls back for unmapped non code files and deleted source files", () => {
    const css = run([modified("src/app/styles.css")]);
    assert.equal(css.mode, "full-suite");
    const deleted = run([{ path: "src/old.ts", status: "deleted" }]);
    assert.equal(deleted.mode, "full-suite");
    assert.match(deleted.fallbackReasons[0] ?? "", /cannot be traced/);
  });

  it("does not select anything for a deleted test", () => {
    const result = run([{ path: "tests/e2e/old.spec.ts", status: "deleted" }]);
    assert.equal(result.mode, "selective");
    assert.equal(result.changedFiles[0]?.outcome, "test-removed");
  });

  it("warns about mappings that match no tests and imports that cannot be resolved", () => {
    const result = run([modified("src/app/page.tsx")], (config) => {
      config.mappings.push({ ...PAGE_MAPPING, tests: ["tests/missing/**"] });
    });
    assert.ok(result.warnings.some((warning) => warning.includes("matched src/app/page.tsx but no test files")));
    assert.ok(result.warnings.some((warning) => warning.includes('Could not resolve "./gone" imported by src/broken.ts')));
  });
});

describe("toText", () => {
  it("summarises the decision, the reasons and the commands to run", () => {
    const text = toText(run([modified("src/money.ts")]));
    assert.match(text, /Decision: SELECTIVE, run 1 of 2 test files/);
    assert.match(text, /\[vitest\] src\/cart\.test\.ts/);
    assert.match(text, /npx vitest run src\/cart\.test\.ts/);
    assert.doesNotMatch(text, /playwright test/);
  });

  it("lists fallback reasons for a full run", () => {
    const text = toText(run([modified("package.json")]));
    assert.match(text, /FULL SUITE, run all 2 test files/);
    assert.match(text, /npx vitest run\n {2}npx playwright test/);
  });
});

describe("analyze safety when the import graph is incomplete", () => {
  // A second unit test that also reaches money.ts, but through an import RiskPilot cannot follow.
  const blindTest = (importLine: string) => ({
    "src/blind.test.ts": `import { it } from "vitest";\n${importLine}\nimport { total } from "./cart";`,
  });

  it("does not add conservative selections when import analysis was not needed", () => {
    const result = run([modified("README.md")], undefined, blindTest('import "./missing";'));
    assert.deepEqual(result.selectedTests, []);
  });

  it("conservatively selects a test with an unresolved relative import", () => {
    const result = run([modified("src/orphan.ts")], (config) => config.mappings.push({ ...PAGE_MAPPING, changed: ["src/orphan.ts"] }), {
      "src/blind.test.ts": 'import { it } from "vitest";\nimport "./missing";',
    });
    assert.equal(result.mode, "selective");
    assert.ok(selectedPaths(result).includes("src/blind.test.ts"));
    const reasons = result.selectedTests.find((test) => test.path === "src/blind.test.ts")?.reasons ?? [];
    assert.match(reasons[0] ?? "", /import graph is incomplete \(src\/blind\.test\.ts: unresolved import "\.\/missing"\)/);
  });

  it("treats an undeclared bare import, such as an unread alias, as unresolved", () => {
    const result = run([modified("src/orphan.ts")], (config) => config.mappings.push({ ...PAGE_MAPPING, changed: ["src/orphan.ts"] }), {
      "src/blind.test.ts": 'import { it } from "vitest";\nimport { x } from "~/hidden";',
    });
    assert.ok(selectedPaths(result).includes("src/blind.test.ts"));
    assert.ok(result.warnings.some((warning) => warning.includes('Could not resolve "~/hidden"')));
  });

  it("conservatively selects a test that reaches a computed dynamic import", () => {
    const result = run([modified("src/money.ts")], undefined, {
      "src/loader.ts": "export const load = (name: string) => import(`./plugins/${name}`);",
      "src/blind.test.ts": 'import { it } from "vitest";\nimport { load } from "./loader";',
    });
    const reasons = result.selectedTests.find((test) => test.path === "src/blind.test.ts")?.reasons ?? [];
    assert.match(reasons[0] ?? "", /src\/loader\.ts: computed dynamic import/);
  });

  it("selects tests that import an otherwise ignored file", () => {
    const result = run([modified("docs/example.ts")], undefined, {
      "docs/example.ts": "export const example = 1;",
      "src/docs.test.ts": 'import { it } from "vitest";\nimport { example } from "../docs/example";',
    });
    assert.equal(result.changedFiles[0]?.outcome, "covered");
    assert.deepEqual(selectedPaths(result), ["src/docs.test.ts"]);
  });

  it("checks both sides of a rename", () => {
    const awayFromTrigger = run([{ path: "old/vitest.setup.ts", previousPath: "vitest.config.ts", status: "renamed" }]);
    assert.equal(awayFromTrigger.mode, "full-suite");
    const intoIgnored = run([{ path: "docs/orphan.ts", previousPath: "src/orphan.ts", status: "renamed" }]);
    assert.equal(intoIgnored.mode, "full-suite");
    assert.match(intoIgnored.fallbackReasons[0] ?? "", /renamed from src\/orphan\.ts/);
  });

  it("warns when a selected test has no detected framework", () => {
    const result = run([modified("src/plain.test.ts")], undefined, { "src/plain.test.ts": "export {};" });
    assert.ok(result.warnings.some((warning) => warning.includes("no detected framework")));
  });
});
