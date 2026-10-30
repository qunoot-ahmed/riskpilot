import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasDynamicImport, parseImports, resolveImport } from "../src/imports.ts";

describe("parseImports", () => {
  it("finds static, type only, re-export, side effect, dynamic and require imports", () => {
    const source = [
      'import { a,',
      '  b } from "./multi";',
      'import type { T } from "./types";',
      'export { c } from "./reexport";',
      'export * from "./star";',
      'import "./side-effect.css";',
      'const lazy = await import("./lazy");',
      'const old = require("./legacy");',
      'export const label = "not an import";',
    ].join("\n");
    assert.deepEqual(parseImports(source).sort(), [
      "./lazy",
      "./legacy",
      "./multi",
      "./reexport",
      "./side-effect.css",
      "./star",
      "./types",
    ]);
  });
});

describe("resolveImport", () => {
  const files = new Set([
    "src/a.ts",
    "src/b.tsx",
    "src/lib/index.ts",
    "src/styles.css",
    "src/shared/ui/index.ts",
  ]);
  const aliases = { "@/*": ["src/*"] };

  it("resolves relative imports with and without extensions", () => {
    assert.deepEqual(resolveImport("src/x.ts", "./a", files, aliases), { kind: "file", path: "src/a.ts" });
    assert.deepEqual(resolveImport("src/x.ts", "./b", files, aliases), { kind: "file", path: "src/b.tsx" });
    assert.deepEqual(resolveImport("src/x.ts", "./styles.css", files, aliases), {
      kind: "file",
      path: "src/styles.css",
    });
  });

  it("maps a .js specifier to its TypeScript source", () => {
    assert.deepEqual(resolveImport("src/x.ts", "./a.js", files, aliases), { kind: "file", path: "src/a.ts" });
  });

  it("resolves folder imports to an index file", () => {
    assert.deepEqual(resolveImport("src/deep/x.ts", "../lib", files, aliases), {
      kind: "file",
      path: "src/lib/index.ts",
    });
  });

  it("resolves path aliases", () => {
    assert.deepEqual(resolveImport("tests/x.ts", "@/shared/ui", files, aliases), {
      kind: "file",
      path: "src/shared/ui/index.ts",
    });
  });

  it("separates packages from imports that should exist but do not", () => {
    assert.deepEqual(resolveImport("src/x.ts", "react", files, aliases), { kind: "external" });
    assert.deepEqual(resolveImport("src/x.ts", "./missing", files, aliases), { kind: "unresolved" });
    assert.deepEqual(resolveImport("src/x.ts", "@/missing", files, aliases), { kind: "unresolved" });
  });
});

describe("import safety helpers", () => {
  it("finds an import clause that contains a quote inside a comment", () => {
    const source = 'import {\n  a, // the "main" export\n  b,\n} from "./tricky";';
    assert.ok(parseImports(source).includes("./tricky"));
  });

  it("detects computed dynamic imports but not literal ones", () => {
    assert.equal(hasDynamicImport('await import("./literal");'), false);
    assert.equal(hasDynamicImport("await import(name);"), true);
    assert.equal(hasDynamicImport("require(`./${name}`);"), true);
    assert.equal(hasDynamicImport('import.meta.glob("./pages/*.ts");'), true);
  });

  it("only treats declared packages and Node built ins as external when packages are known", () => {
    const packages = new Set(["react", "@scope/ui"]);
    const resolve = (specifier: string) => resolveImport("src/x.ts", specifier, new Set(), {}, packages).kind;
    assert.equal(resolve("react/jsx-runtime"), "external");
    assert.equal(resolve("@scope/ui/button"), "external");
    assert.equal(resolve("node:fs"), "external");
    assert.equal(resolve("path"), "external");
    assert.equal(resolve("~/components/x"), "unresolved");
    assert.equal(resolve("#internal"), "unresolved");
  });
});
