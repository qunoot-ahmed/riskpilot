import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Config, Mapping } from "./types.ts";

/** Changes to these files can affect every test, so they always trigger the full suite. */
export const DEFAULT_FULL_SUITE_TRIGGERS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig*.json",
  "vitest.config.*",
  "vitest.workspace.*",
  "vite.config.*",
  "playwright.config.*",
  ".nvmrc",
  ".node-version",
  // Changing the mappings changes the selection itself, so it cannot be checked by that selection.
  "riskpilot.config.json",
];

/** Changes to these files cannot affect test results. */
export const DEFAULT_IGNORE = ["*.md", "LICENSE", "docs/**", ".gitignore", ".gitattributes", ".editorconfig"];

export function defaultConfig(): Config {
  return {
    fullSuiteTriggers: [...DEFAULT_FULL_SUITE_TRIGGERS],
    ignore: [...DEFAULT_IGNORE],
    aliases: {},
    mappings: [],
  };
}

/** Reads a RiskPilot JSON config file. Its lists extend the defaults rather than replacing them. */
export function loadConfig(path: string | undefined): Config {
  if (!path) return defaultConfig();
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read config ${path}: ${(error as Error).message}`);
  }
  return parseConfig(source, path);
}

/** Parses RiskPilot config JSON. The label names the source in error messages. */
export function parseConfig(source: string, label: string): Config {
  const config = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not read config ${label}: ${(error as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`Config ${label} must contain a JSON object.`);

  config.fullSuiteTriggers.push(...stringList(raw.fullSuiteTriggers, "fullSuiteTriggers"));
  config.ignore.push(...stringList(raw.ignore, "ignore"));
  if (raw.aliases !== undefined) {
    if (!isObject(raw.aliases)) throw new Error("Config field aliases must be an object.");
    for (const [key, value] of Object.entries(raw.aliases)) {
      config.aliases[key] = stringList(value, `aliases.${key}`);
    }
  }
  if (raw.mappings !== undefined) {
    if (!Array.isArray(raw.mappings)) throw new Error("Config field mappings must be an array.");
    config.mappings = raw.mappings.map(parseMapping);
  }
  return config;
}

function parseMapping(value: unknown, index: number): Mapping {
  const label = `mappings[${index}]`;
  if (!isObject(value)) throw new Error(`Config ${label} must be an object.`);
  const changed = stringList(value.changed, `${label}.changed`);
  const tests = stringList(value.tests, `${label}.tests`);
  if (changed.length === 0 || tests.length === 0) {
    throw new Error(`Config ${label} needs at least one "changed" and one "tests" pattern.`);
  }
  const name = typeof value.name === "string" ? value.name : label;
  const reason = typeof value.reason === "string" ? value.reason : "explicit mapping";
  return { name, changed, tests, reason };
}

/**
 * Reads path aliases from a root tsconfig.json. Returns undefined when the file is not plain JSON
 * (for example it has comments), so the caller can warn and rely on config aliases instead.
 */
export function aliasesFromTsconfig(source: string): Record<string, string[]> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  const options = isObject(parsed) && isObject(parsed.compilerOptions) ? parsed.compilerOptions : {};
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const aliases: Record<string, string[]> = {};
  if (isObject(options.paths)) {
    for (const [key, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) {
        aliases[key] = targets.filter((t) => typeof t === "string").map((t) => posix.join(baseUrl, t));
      }
    }
  }
  return aliases;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new Error(`Config field ${field} must be a string or an array of strings.`);
  }
  return list;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
