import type { AgentProfile } from "./profile.ts";

/** Codex through codex-acp, in Codex's own read-only or workspace-write sandbox. */
export const codex: AgentProfile = {
  name: "codex",
  adapter: "@agentclientprotocol/codex-acp@2.2.2",
  session: ({ permissions }) =>
    Promise.resolve({
      env: {},
      sessionMeta: undefined,
      configOptions: { mode: permissions === "read" ? "read-only" : "workspace-write" },
      // Codex reads files with shell commands. Its read-only sandbox blocks writes and network access itself.
      allowKinds: ["execute"],
      clean: false,
      cleanNote:
        "Codex reads its home folder, which holds both the login and the user's instructions. acp-jury does not copy the login, so the user's instructions stay on.",
    }),
};
