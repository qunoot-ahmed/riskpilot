/**
 * Minimal glob matching for repository relative paths.
 * Supports "**", "*" and "?". A pattern without a slash matches the file name in any folder,
 * so "*.md" matches "docs/guide.md".
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const target = pattern.includes("/") ? path : (path.split("/").pop() ?? path);
  return globToRegExp(pattern).test(target);
}

export function matchesAny(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesGlob(path, pattern));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      const followedBySlash = pattern[i + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      i += followedBySlash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
