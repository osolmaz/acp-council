import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Reads a text file for an agent, only inside the member's folder. `line` is 1-based. */
export async function readInside(
  root: string,
  path: string,
  line?: number | null,
  limit?: number | null,
): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, path));
  if (!inside(realRoot, target)) {
    throw new Error(`reading outside the member's folder is not allowed: ${path}`);
  }
  return sliceLines(await readFile(target, "utf8"), line ?? null, limit ?? null);
}

/** The lines from `line` (1-based), at most `limit` of them. */
export function sliceLines(content: string, line: number | null, limit: number | null): string {
  if (line === null && limit === null) {
    return content;
  }
  const start = Math.max((line ?? 1) - 1, 0);
  return content
    .split("\n")
    .slice(start, limit === null ? undefined : start + limit)
    .join("\n");
}
