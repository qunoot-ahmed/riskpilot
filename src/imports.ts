import { isBuiltin } from "node:module";
import { posix } from "node:path";

export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']/g;
// Catches import clauses that STATIC_IMPORT misses, for example a quote inside a comment between the braces.
const FROM_CLAUSE = /\bfrom\s+["']([^"'\n]+)["']/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*(?!["'][^"'\n]*["']\s*\))|\bimport\.meta\.glob\b/;

/**
 * Extracts module specifiers with regular expressions.
 * This is deliberately simple: it does not understand comments or template literal imports.
 * Over matching is safe because it only selects more tests.
 */
export function parseImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [STATIC_IMPORT, FROM_CLAUSE, CALL_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/** True when the source loads modules through a computed path that parseImports cannot see. */
export function hasDynamicImport(source: string): boolean {
  return DYNAMIC_IMPORT.test(source);
}

/** Returns the package name of a bare specifier: "@scope/pkg/sub" gives "@scope/pkg", "pkg/sub" gives "pkg". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "external" }
  | { kind: "unresolved" };

/**
 * Resolves an import to a tracked repository file using relative paths and path aliases.
 * When the declared packages are known, a bare specifier is only external if it names one of them
 * or a Node built in. Anything else (an alias RiskPilot could not read, for example) is unresolved.
 */
export function resolveImport(
  importer: string,
  specifier: string,
  files: ReadonlySet<string>,
  aliases: Record<string, string[]>,
  packages?: ReadonlySet<string>,
): Resolution {
  let bases: string[];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    bases = [posix.join(posix.dirname(importer), specifier)];
  } else {
    bases = expandAlias(specifier, aliases);
    if (bases.length === 0) {
      const known = !packages || isBuiltin(specifier) || packages.has(packageName(specifier));
      return known ? { kind: "external" } : { kind: "unresolved" };
    }
  }

  for (const base of bases) {
    for (const candidate of candidates(posix.normalize(base))) {
      if (files.has(candidate)) return { kind: "file", path: candidate };
    }
  }
  return { kind: "unresolved" };
}

function expandAlias(specifier: string, aliases: Record<string, string[]>): string[] {
  for (const [pattern, targets] of Object.entries(aliases)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        return targets.map((target) => target.replace("*", rest));
      }
    } else if (pattern === specifier) {
      return targets;
    }
  }
  return [];
}

function candidates(base: string): string[] {
  const stripped = base.replace(/^\.\//, "");
  const list = [stripped];
  // TypeScript lets "./x.js" refer to "./x.ts".
  const jsMatch = /\.(m|c)?jsx?$/.exec(stripped);
  if (jsMatch) {
    const withoutExtension = stripped.slice(0, -jsMatch[0].length);
    list.push(`${withoutExtension}.${jsMatch[1] ?? ""}ts`, `${withoutExtension}.tsx`);
  }
  for (const extension of CODE_EXTENSIONS) list.push(`${stripped}${extension}`);
  for (const extension of CODE_EXTENSIONS) list.push(`${stripped}/index${extension}`);
  return list;
}
