import type { AgentName, MemberConfig } from "../config/schema.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { pi } from "./pi.ts";
import type { AgentProfile, LaunchPlan, Permissions } from "./profile.ts";

export const AGENTS: Record<AgentName, AgentProfile> = { claude, codex, pi };

/**
 * Plans how to start a member. A built-in agent runs its pinned adapter with `npx`, unless the member gives its own
 * command, for example to pin another adapter version. A member with only a command is a custom agent.
 */
export async function planLaunch(
  member: MemberConfig,
  permissions: Permissions,
  scratchDir: string,
): Promise<LaunchPlan> {
  if (member.agent === undefined) {
    return {
      agent: null,
      command: member.command ?? [],
      env: {},
      sessionMeta: undefined,
      configOptions: {},
      allowKinds: [],
      clean: null,
      cleanNote: "A custom command: acp-council cannot tell whether it runs clean.",
    };
  }
  const profile = AGENTS[member.agent];
  return {
    agent: profile.name,
    command: member.command ?? ["npx", "-y", profile.adapter],
    ...(await profile.session({ member, permissions, scratchDir })),
  };
}
