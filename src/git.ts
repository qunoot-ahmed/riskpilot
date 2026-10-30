import { execFileSync } from "node:child_process";
import type { ChangedFile, ChangeStatus, Snapshot } from "./types.ts";

const MAX_BUFFER = 256 * 1024 * 1024;

function git(repo: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      input,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`git ${args[0]} failed: ${stderr || (error as Error).message}`);
  }
}

export function repositoryRoot(path: string): string {
  return git(path, ["rev-parse", "--show-toplevel"]).toString().trim();
}

/** Resolves a revision such as a branch, tag or SHA to a full commit SHA. */
export function resolveRevision(repo: string, revision: string): string {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).toString().trim();
  } catch {
    throw new Error(`Unknown revision "${revision}" in ${repo}.`);
  }
}

/** Finds the best common ancestor, so a pull request is compared only with what it changes. */
export function mergeBase(repo: string, base: string, head: string): string {
  try {
    return git(repo, ["merge-base", base, head]).toString().trim();
  } catch {
    throw new Error(`No merge base between ${base} and ${head}. Fetch full history (fetch-depth: 0) or check the revisions.`);
  }
}

const STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Lists files that differ between two revisions, with rename detection. */
export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const fields = git(repo, ["diff", "--name-status", "-z", "-M", base, head]).toString().split("\0");
  const changes: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++] ?? "";
    if (code === "") continue;
    const status = STATUS[code.charAt(0)] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const previousPath = fields[i++] ?? "";
      changes.push({ path: fields[i++] ?? "", status, previousPath });
    } else {
      changes.push({ path: fields[i++] ?? "", status });
    }
  }
  return changes;
}

/**
 * Reads the tracked files of a revision straight from the object database, so the working tree
 * of the analysed repository is never read or modified. Only files accepted by shouldRead are loaded.
 */
export function readSnapshot(repo: string, revision: string, shouldRead: (path: string) => boolean): Snapshot {
  const paths = git(repo, ["ls-tree", "-r", "-z", "--name-only", revision])
    .toString()
    .split("\0")
    .filter(Boolean);
  const wanted = paths.filter((path) => shouldRead(path) && !path.includes("\n"));
  const contents = new Map<string, string>();
  if (wanted.length === 0) return { paths, contents };

  const output = git(repo, ["cat-file", "--batch"], wanted.map((path) => `${revision}:${path}\n`).join(""));
  let offset = 0;
  for (const path of wanted) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString();
    offset = headerEnd + 1;
    const [, type, size] = header.split(" ");
    if (type === undefined || size === undefined) continue; // "missing" objects have no body
    const length = Number(size);
    if (type === "blob") contents.set(path, output.subarray(offset, offset + length).toString("utf8"));
    offset += length + 1;
  }
  return { paths, contents };
}
