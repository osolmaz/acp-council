import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Permissions } from "./agents.ts";

const ALLOWED_KINDS: Record<Permissions, ToolKind[]> = {
  read: ["read", "search", "think"],
  exec: ["read", "search", "think", "execute"],
};

const CANCEL = /cancel/i;

/** Prefers the first option of the wanted kinds that does not cancel the turn, such as Codex's `decline` over `cancel`. */
function pick(options: PermissionOption[], kinds: string[]): PermissionOption | undefined {
  const matching = options.filter((option) => kinds.includes(option.kind));
  return matching.find((option) => !CANCEL.test(option.optionId) && !CANCEL.test(option.name)) ?? matching[0];
}

/**
 * Answers a permission request: allow read and search tools (and commands under `exec`), deny the rest.
 * `extraKinds` are kinds that an agent profile also allows, because the agent enforces the same limit itself.
 */
export function choosePermission(
  request: RequestPermissionRequest,
  permissions: Permissions,
  extraKinds: ToolKind[] = [],
): RequestPermissionResponse {
  const kind = request.toolCall.kind ?? "other";
  const allowed = [...ALLOWED_KINDS[permissions], ...extraKinds].includes(kind);
  const option = pick(request.options, allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]);
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: option.optionId } };
}

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
