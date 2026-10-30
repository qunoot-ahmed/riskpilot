#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "./analyze.ts";
import { aliasesFromTsconfig, defaultConfig, loadConfig, parseConfig } from "./config.ts";
import { changedFiles, mergeBase, readSnapshot, repositoryRoot, resolveRevision } from "./git.ts";
import { isCodeFile } from "./imports.ts";
import { toErrorJson, toErrorMarkdown, toJson, toMarkdown, toText } from "./report.ts";
import type { AnalysisResult } from "./types.ts";

const CONFIG_FILE = "riskpilot.config.json";

const USAGE = `Usage: riskpilot <repo> <base> [head] [options]

Selects the Vitest and Playwright tests affected by the changes between two Git revisions.
The head revision defaults to HEAD. The analysed repository is only read, never modified.

Options:
  --merge-base        Compare from the merge base of base and head, as a pull request does
  --config <file>     RiskPilot JSON config (default: ${CONFIG_FILE} in the head revision, if present)
  --json              Print JSON instead of the text summary
  --output <file>     Also write the JSON result to a file
  --markdown <file>   Also write a Markdown summary to a file
  --help              Show this help

On failure the exit code is 1, and --output and --markdown files describe the error.
`;

interface Options {
  repo: string;
  base: string;
  head: string;
  mergeBase: boolean;
  config: string | undefined;
}

function run(options: Options): AnalysisResult {
  const repository = repositoryRoot(resolve(options.repo));
  const head = resolveRevision(repository, options.head);
  const requestedBase = resolveRevision(repository, options.base);
  const base = options.mergeBase ? mergeBase(repository, requestedBase, head) : requestedBase;

  const wanted = new Set(["tsconfig.json", "package.json", CONFIG_FILE]);
  const snapshot = readSnapshot(repository, head, (path) => isCodeFile(path) || wanted.has(path));

  // The default config comes from the head revision, like every other file the analysis reads.
  const committedConfig = snapshot.contents.get(CONFIG_FILE);
  const config = options.config
    ? loadConfig(options.config)
    : committedConfig !== undefined
      ? parseConfig(committedConfig, `${CONFIG_FILE} at ${head.slice(0, 7)}`)
      : defaultConfig();

  const warnings: string[] = [];
  const tsconfig = snapshot.contents.get("tsconfig.json");
  if (tsconfig !== undefined) {
    const aliases = aliasesFromTsconfig(tsconfig);
    if (aliases) config.aliases = { ...aliases, ...config.aliases };
    else warnings.push("tsconfig.json is not plain JSON, so its path aliases were not read. Add them to the config.");
  }

  return analyze({
    repository,
    base,
    head,
    comparison: options.mergeBase ? "merge-base" : "direct",
    changes: changedFiles(repository, base, head),
    snapshot,
    config,
    warnings,
  });
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "merge-base": { type: "boolean", default: false },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      output: { type: "string" },
      markdown: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [repo, base, head = "HEAD"] = positionals;
  if (!repo || !base || positionals.length > 3) {
    process.stderr.write(USAGE);
    return 2;
  }

  let result: AnalysisResult;
  try {
    result = run({ repo, base, head, mergeBase: values["merge-base"], config: values.config });
  } catch (error) {
    const message = (error as Error).message;
    if (values.output) writeFileSync(values.output, toErrorJson(message));
    if (values.markdown) writeFileSync(values.markdown, toErrorMarkdown(message));
    process.stderr.write(`riskpilot: ${message}\n`);
    return 1;
  }

  if (values.output) writeFileSync(values.output, toJson(result));
  if (values.markdown) writeFileSync(values.markdown, toMarkdown(result));
  process.stdout.write(values.json ? toJson(result) : toText(result));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`riskpilot: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
