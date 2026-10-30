import type { AnalysisResult, ChangeStatus, Framework } from "./types.ts";
import { count } from "./text.ts";

const STATUS_LETTER: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
};

/** The text summary shows this many reasons per test. The JSON output keeps all of them. */
const MAX_REASONS = 3;

export function toJson(result: AnalysisResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function toText(result: AnalysisResult): string {
  const lines: string[] = [];
  const short = (sha: string) => sha.slice(0, 7);
  lines.push("RiskPilot test impact analysis");
  lines.push(`Repository: ${result.repository}`);
  lines.push(`Range:      ${short(result.base)}..${short(result.head)} (${count(result.changedFiles.length, "changed file")})`);
  lines.push("");

  if (result.mode === "full-suite") {
    lines.push(`Decision: FULL SUITE, run all ${count(result.totalTests, "test file")}`);
    lines.push("Fallback reasons:");
    for (const reason of result.fallbackReasons) lines.push(`  - ${reason}`);
  } else {
    lines.push(`Decision: SELECTIVE, run ${result.selectedTests.length} of ${count(result.totalTests, "test file")}`);
  }
  lines.push("");

  lines.push("Changed files:");
  if (result.changedFiles.length === 0) lines.push("  (none)");
  for (const file of result.changedFiles) {
    lines.push(`  ${STATUS_LETTER[file.status]} ${file.path}`);
    lines.push(`      ${file.outcome}: ${file.detail}`);
  }
  lines.push("");

  lines.push("Selected tests:");
  if (result.selectedTests.length === 0) lines.push("  (none)");
  for (const test of result.selectedTests) {
    lines.push(`  [${test.framework}] ${test.path}`);
    for (const reason of test.reasons.slice(0, MAX_REASONS)) lines.push(`      - ${reason}`);
    const hidden = test.reasons.length - MAX_REASONS;
    if (hidden > 0) lines.push(`      - and ${hidden} more (see JSON output)`);
  }

  const commands = suggestedCommands(result);
  if (commands.length > 0) {
    lines.push("");
    lines.push("Suggested commands:");
    for (const command of commands) lines.push(`  ${command}`);
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function suggestedCommands(result: AnalysisResult): string[] {
  const byFramework = (framework: Framework) =>
    result.selectedTests.filter((test) => test.framework === framework).map((test) => quote(test.path));
  const vitest = byFramework("vitest");
  const playwright = byFramework("playwright");
  if (result.mode === "full-suite") {
    return [vitest.length > 0 && "npx vitest run", playwright.length > 0 && "npx playwright test"].filter(
      (command): command is string => typeof command === "string",
    );
  }
  const commands: string[] = [];
  if (vitest.length > 0) commands.push(`npx vitest run ${vitest.join(" ")}`);
  if (playwright.length > 0) commands.push(`npx playwright test ${playwright.join(" ")}`);
  return commands;
}

function quote(path: string): string {
  return /^[\w./@-]+$/.test(path) ? path : `"${path}"`;
}
