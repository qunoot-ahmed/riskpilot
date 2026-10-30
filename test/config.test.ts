import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { aliasesFromTsconfig, DEFAULT_IGNORE, loadConfig } from "../src/config.ts";

function writeConfig(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "riskpilot-config-")), "riskpilot.config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadConfig", () => {
  it("returns the defaults without a config file", () => {
    const config = loadConfig(undefined);
    assert.deepEqual(config.ignore, DEFAULT_IGNORE);
    assert.deepEqual(config.mappings, []);
  });

  it("extends the default lists and normalises single strings", () => {
    const config = loadConfig(
      writeConfig({
        ignore: ".github/**",
        mappings: [{ name: "Wall", changed: "src/wall/**", tests: ["tests/e2e/wall.spec.ts"], reason: "visits /wall" }],
      }),
    );
    assert.ok(config.ignore.includes("*.md"));
    assert.ok(config.ignore.includes(".github/**"));
    assert.deepEqual(config.mappings[0], {
      name: "Wall",
      changed: ["src/wall/**"],
      tests: ["tests/e2e/wall.spec.ts"],
      reason: "visits /wall",
    });
  });

  it("rejects invalid JSON and invalid mappings with readable errors", () => {
    assert.throws(() => loadConfig(writeConfig("{ nope")), /Could not read config/);
    assert.throws(() => loadConfig(writeConfig({ mappings: [{ changed: ["a"] }] })), /mappings\[0\]/);
    assert.throws(() => loadConfig(writeConfig({ ignore: [1] })), /ignore must be a string/);
  });
});

describe("aliasesFromTsconfig", () => {
  it("reads paths relative to baseUrl", () => {
    const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } });
    assert.deepEqual(aliasesFromTsconfig(tsconfig), { "@/*": ["src/*"] });
  });

  it("returns undefined for a tsconfig with comments", () => {
    assert.equal(aliasesFromTsconfig('{ // comment\n "compilerOptions": {} }'), undefined);
  });
});
