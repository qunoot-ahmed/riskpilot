export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  previousPath?: string;
}

export type Framework = "vitest" | "playwright" | "unknown";

export interface TestFile {
  path: string;
  framework: Framework;
}

export interface Mapping {
  name: string;
  changed: string[];
  tests: string[];
  reason: string;
}

export interface Config {
  fullSuiteTriggers: string[];
  ignore: string[];
  aliases: Record<string, string[]>;
  mappings: Mapping[];
}

/** The files of one revision: every tracked path, plus the contents of code files. */
export interface Snapshot {
  paths: string[];
  contents: Map<string, string>;
}

export type FileOutcome = "ignored" | "test-changed" | "test-removed" | "covered" | "full-suite";

export interface FileDecision {
  path: string;
  status: ChangeStatus;
  outcome: FileOutcome;
  detail: string;
}

export interface SelectedTest {
  path: string;
  framework: Framework;
  reasons: string[];
}

export interface AnalysisResult {
  repository: string;
  base: string;
  head: string;
  mode: "selective" | "full-suite";
  fallbackReasons: string[];
  totalTests: number;
  changedFiles: FileDecision[];
  selectedTests: SelectedTest[];
  warnings: string[];
}
