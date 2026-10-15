import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Permissions } from "../agents/profile.ts";

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
