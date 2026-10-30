import { discoverTests, isTestPath } from "./discover.ts";
import { matchesAny, matchesGlob } from "./glob.ts";
import { hasDynamicImport, isCodeFile, parseImports, resolveImport } from "./imports.ts";
import { count } from "./text.ts";
import type { AnalysisResult, ChangedFile, Config, FileDecision, SelectedTest, Snapshot, TestFile } from "./types.ts";

export interface AnalysisInput {
  repository: string;
  base: string;
  head: string;
  changes: ChangedFile[];
  /** Files of the head revision. */
  snapshot: Snapshot;
  config: Config;
  /** Extra warnings gathered before analysis, such as an unreadable tsconfig. */
  warnings?: string[];
}

/**
 * Decides which tests a change set needs. Each changed file is classified in order:
 * full suite trigger, test file, explicit mapping, import dependency, ignored.
 * A file that none of these explain makes the whole run fall back to the full suite.
 * Tests whose import graph is incomplete are selected whenever selection relies on that graph.
 */
export function analyze(input: AnalysisInput): AnalysisResult {
  const { snapshot, config } = input;
  const warnings = [...(input.warnings ?? [])];
  const tests = discoverTests(snapshot.paths, snapshot.contents);
  const packages = declaredPackages(snapshot, warnings);
  const { graph, uncertain } = buildImportGraph(snapshot, config.aliases, warnings, packages);
  const reach = new Map(tests.map((test) => [test.path, walkImports(test.path, graph)]));

  const selections = new Map<string, Set<string>>();
  const select = (testPath: string, reason: string) => {
    const reasons = selections.get(testPath) ?? new Set<string>();
    reasons.add(reason);
    selections.set(testPath, reasons);
  };
  const fallbackReasons: string[] = [];
  const decisions: FileDecision[] = [];

  for (const change of input.changes) {
    const decide = (outcome: FileDecision["outcome"], detail: string) =>
      decisions.push({ path: change.path, status: change.status, outcome, detail });
    const { path } = change;
    const deleted = change.status === "deleted";
    // A rename also removes the old path, so both paths must be safe to treat as the new one.
    const paths = change.status === "renamed" && change.previousPath ? [path, change.previousPath] : [path];

    const trigger = paths.map((p) => [p, matchesAny(p, config.fullSuiteTriggers)] as const).find(([, t]) => t);
    if (trigger) {
      decide("full-suite", `matches full suite trigger "${trigger[1]}"`);
      fallbackReasons.push(`${trigger[0]} matches full suite trigger "${trigger[1]}"`);
      continue;
    }

    if (isTestPath(path)) {
      if (deleted) {
        decide("test-removed", "test file was deleted, nothing to run");
      } else {
        select(path, "test file changed directly");
        decide("test-changed", "selected because the test itself changed");
      }
      continue;
    }

    const covering: string[] = [];

    for (const mapping of config.mappings) {
      if (!paths.some((p) => mapping.changed.some((pattern) => matchesGlob(p, pattern)))) continue;
      const mapped = tests.filter((test) => matchesAny(test.path, mapping.tests));
      if (mapped.length === 0) warnings.push(`Mapping "${mapping.name}" matched ${path} but no test files.`);
      for (const test of mapped) select(test.path, `mapping "${mapping.name}": ${mapping.reason} (${path})`);
      if (mapped.length > 0) covering.push(`mapping "${mapping.name}" (${count(mapped.length, "test")})`);
    }

    if (!deleted) {
      let traced = 0;
      for (const test of tests) {
        const chain = chainTo(path, reach.get(test.path));
        if (!chain) continue;
        traced++;
        const via = chain.slice(1, -1);
        select(test.path, via.length === 0 ? `imports ${path} directly` : `imports ${path} through ${via.join(" -> ")}`);
      }
      if (traced > 0) covering.push(`reached by ${count(traced, "test")} through imports`);
    }

    if (covering.length > 0) {
      decide("covered", covering.join("; "));
      continue;
    }

    // Ignore patterns apply only when no test reaches the file, and to both sides of a rename.
    const ignoredBy = paths.every((p) => matchesAny(p, config.ignore)) ? matchesAny(path, config.ignore) : undefined;
    if (ignoredBy) {
      decide("ignored", `matches ignore pattern "${ignoredBy}"`);
      continue;
    }

    const why = deleted
      ? "deleted file cannot be traced in the head revision"
      : paths.length > 1 && isCodeFile(paths[1] ?? "")
        ? `renamed from ${paths[1]}, which cannot be traced in the head revision`
        : isCodeFile(path)
          ? "no test imports it and no mapping covers it"
          : "non code file with no mapping";
    decide("full-suite", why);
    fallbackReasons.push(`${path}: ${why}`);
  }

  // A missing import edge could hide a dependency on any changed file, so these tests always run.
  if (decisions.some((decision) => decision.outcome === "covered")) {
    for (const test of tests) {
      const blind = [...(reach.get(test.path)?.keys() ?? [])].find((file) => uncertain.has(file));
      if (blind) select(test.path, `import graph is incomplete (${blind}: ${uncertain.get(blind)}), selected conservatively`);
    }
  }

  const mode = fallbackReasons.length > 0 ? "full-suite" : "selective";
  const chosen: TestFile[] = mode === "full-suite" ? tests : tests.filter((test) => selections.has(test.path));
  const selectedTests: SelectedTest[] = chosen.map((test) => ({
    path: test.path,
    framework: test.framework,
    reasons: [...(selections.get(test.path) ?? ["full suite fallback"])],
  }));

  const unknown = selectedTests.filter((test) => test.framework === "unknown");
  if (unknown.length > 0) {
    warnings.push(
      `${count(unknown.length, "selected test")} with no detected framework, missing from the suggested commands: ${unknown.map((t) => t.path).join(", ")}.`,
    );
  }

  return {
    repository: input.repository,
    base: input.base,
    head: input.head,
    mode,
    fallbackReasons,
    totalTests: tests.length,
    changedFiles: decisions,
    selectedTests,
    warnings,
  };
}

/** Package names from the root package.json, or undefined when it cannot be read. */
export function declaredPackages(snapshot: Snapshot, warnings: string[]): Set<string> | undefined {
  const source = snapshot.contents.get("package.json");
  try {
    if (source === undefined) throw new Error("missing");
    const manifest = JSON.parse(source) as Record<string, unknown>;
    const names = new Set<string>(typeof manifest.name === "string" ? [manifest.name] : []);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (typeof deps === "object" && deps !== null) for (const name of Object.keys(deps)) names.add(name);
    }
    return names;
  } catch {
    warnings.push("No readable root package.json, so every bare import is assumed to be a package.");
    return undefined;
  }
}

export type ImportGraph = Map<string, string[]>;

/**
 * Builds the import graph. Files whose imports could not all be followed are returned in
 * uncertain, mapped to the reason.
 */
export function buildImportGraph(
  snapshot: Snapshot,
  aliases: Record<string, string[]>,
  warnings: string[],
  packages?: ReadonlySet<string>,
): { graph: ImportGraph; uncertain: Map<string, string> } {
  const files = new Set(snapshot.paths);
  const graph: ImportGraph = new Map();
  const uncertain = new Map<string, string>();
  for (const [path, source] of snapshot.contents) {
    if (!isCodeFile(path)) continue;
    const edges: string[] = [];
    for (const specifier of parseImports(source)) {
      const resolved = resolveImport(path, specifier, files, aliases, packages);
      if (resolved.kind === "file") edges.push(resolved.path);
      else if (resolved.kind === "unresolved") {
        warnings.push(`Could not resolve "${specifier}" imported by ${path}.`);
        uncertain.set(path, `unresolved import "${specifier}"`);
      }
    }
    if (hasDynamicImport(source) && !uncertain.has(path)) uncertain.set(path, "computed dynamic import");
    graph.set(path, edges);
  }
  return { graph, uncertain };
}

/** Breadth first walk from a test. Maps each reachable file to the file that imported it. */
export function walkImports(start: string, graph: ImportGraph): Map<string, string> {
  const parents = new Map<string, string>([[start, start]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of graph.get(current) ?? []) {
      if (!parents.has(next)) {
        parents.set(next, current);
        queue.push(next);
      }
    }
  }
  return parents;
}

/** Returns the shortest import chain from the test to the target, or undefined if unreachable. */
function chainTo(target: string, parents: Map<string, string> | undefined): string[] | undefined {
  if (!parents?.has(target)) return undefined;
  const chain = [target];
  let current = target;
  while (parents.get(current) !== current) {
    current = parents.get(current) as string;
    chain.unshift(current);
  }
  return chain.length > 1 ? chain : undefined;
}
