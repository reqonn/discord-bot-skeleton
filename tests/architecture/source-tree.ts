import { readdirSync } from "node:fs";

/**
 * The one walk of the tree, for every gate that reads it.
 *
 * Each gate used to carry its own `readdir`, and the copies drifted: one
 * skipped a directory another judged, one used backslashes on Windows and
 * matched nothing. A gate that walks differently from the others is a gate
 * whose "nothing found" cannot be told apart from "looked in the wrong place".
 */

/** One entry directly inside a directory. */
export interface TreeEntry {
  readonly name: string;
  /** `dir` and `name` joined with a forward slash. */
  readonly path: string;
  readonly isDirectory: boolean;
}

/** What sits directly inside a directory, for gates that read the tree's shape. */
export function entriesIn(dir: string): readonly TreeEntry[] {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: `${dir}/${entry.name}`,
    isDirectory: entry.isDirectory(),
  }));
}

/**
 * Every file under a directory that a gate should judge.
 *
 * `keep` sees each path joined below `dir` with forward slashes, so relative
 * to the repository root when `dir` is written that way.
 */
export function filesUnder(dir: string, keep: (path: string) => boolean): readonly string[] {
  return entriesIn(dir).flatMap((entry) => {
    if (entry.isDirectory) return filesUnder(entry.path, keep);
    return keep(entry.path) ? [entry.path] : [];
  });
}
