import type { Framework, TestFile } from "./types.ts";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Finds Vitest and Playwright test files by name, then identifies the framework from imports. */
export function discoverTests(paths: readonly string[], contents: ReadonlyMap<string, string>): TestFile[] {
  return paths
    .filter(isTestPath)
    .map((path) => ({ path, framework: detectFramework(contents.get(path) ?? "") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function detectFramework(source: string): Framework {
  if (/["']@playwright\/test["']/.test(source)) return "playwright";
  if (/["']vitest["']/.test(source)) return "vitest";
  return "unknown";
}
