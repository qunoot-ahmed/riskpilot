import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesAny, matchesGlob } from "../src/glob.ts";

describe("matchesGlob", () => {
  it("matches file name patterns in any folder when the pattern has no slash", () => {
    assert.equal(matchesGlob("docs/guide/setup.md", "*.md"), true);
    assert.equal(matchesGlob("packages/a/package.json", "package.json"), true);
    assert.equal(matchesGlob("src/readme.ts", "*.md"), false);
  });

  it("treats a single star as one path segment", () => {
    assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
    assert.equal(matchesGlob("src/deep/a.ts", "src/*.ts"), false);
  });

  it("lets a double star cross folders, including zero folders", () => {
    assert.equal(matchesGlob("src/a.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("src/x/y/a.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("docs/a/b.png", "docs/**"), true);
  });

  it("escapes regular expression characters such as parentheses", () => {
    assert.equal(matchesGlob("src/app/(site)/wall/page.tsx", "src/app/(site)/wall/**"), true);
    assert.equal(matchesGlob("src/app/site/wall/page.tsx", "src/app/(site)/wall/**"), false);
  });

  it("returns the first matching pattern", () => {
    assert.equal(matchesAny("vitest.config.ts", ["*.md", "vitest.config.*"]), "vitest.config.*");
    assert.equal(matchesAny("src/a.ts", ["*.md"]), undefined);
  });
});
