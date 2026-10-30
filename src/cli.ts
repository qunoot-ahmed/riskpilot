#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "./analyze.ts";
import { aliasesFromTsconfig, loadConfig } from "./config.ts";
import { changedFiles, readSnapshot, repositoryRoot, resolveRevision } from "./git.ts";
import { isCodeFile } from "./imports.ts";
import { toJson, toText } from "./report.ts";

const USAGE = `Usage: riskpilot <repo> <base> [head] [options]

Selects the Vitest and Playwright tests affected by the changes between two Git revisions.
The head revision defaults to HEAD. The analysed repository is only read, never modified.

Options:
  --config <file>   RiskPilot JSON config (default: <repo>/riskpilot.config.json if present)
  --json            Print JSON instead of the text summary
  --output <file>   Also write the JSON result to a file
  --help            Show this help
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [repoArg, baseArg, headArg = "HEAD"] = positionals;
  if (!repoArg || !baseArg || positionals.length > 3) {
    process.stderr.write(USAGE);
    return 2;
  }

  const repository = repositoryRoot(resolve(repoArg));
  const base = resolveRevision(repository, baseArg);
  const head = resolveRevision(repository, headArg);

  const defaultConfig = join(repository, "riskpilot.config.json");
  const configPath = values.config ?? (existsSync(defaultConfig) ? defaultConfig : undefined);
  const config = loadConfig(configPath);

  const snapshot = readSnapshot(repository, head, (path) => isCodeFile(path) || path === "tsconfig.json" || path === "package.json");
  const warnings: string[] = [];
  const tsconfig = snapshot.contents.get("tsconfig.json");
  if (tsconfig !== undefined) {
    const aliases = aliasesFromTsconfig(tsconfig);
    if (aliases) config.aliases = { ...aliases, ...config.aliases };
    else warnings.push("tsconfig.json is not plain JSON, so its path aliases were not read. Add them to the config.");
  }

  const result = analyze({
    repository,
    base,
    head,
    changes: changedFiles(repository, base, head),
    snapshot,
    config,
    warnings,
  });

  if (values.output) writeFileSync(values.output, toJson(result));
  process.stdout.write(values.json ? toJson(result) : toText(result));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`riskpilot: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
