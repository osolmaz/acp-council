import type { AgentProfile, Permissions } from "./profile.ts";

const TOOLS: Record<Permissions, string[]> = {
  read: ["Read", "Grep", "Glob"],
  exec: ["Read", "Grep", "Glob", "Bash"],
};

/** Claude Code through claude-agent-acp. No setting sources, so no user settings, CLAUDE.md files or skills. */
export const claude: AgentProfile = {
  name: "claude",
  adapter: "@agentclientprotocol/claude-agent-acp@0.91.0",
  session: ({ permissions }) =>
    Promise.resolve({
      env: {},
      sessionMeta: { claudeCode: { options: { settingSources: [], tools: TOOLS[permissions] } } },
      configOptions: {},
      allowKinds: [],
      clean: true,
      cleanNote: "Claude Code runs with no setting sources: no user or project settings, CLAUDE.md files or skills.",
    }),
};
