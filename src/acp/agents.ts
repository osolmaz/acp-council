import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolKind } from "@agentclientprotocol/sdk";
import type { AgentName, MemberConfig } from "../config/schema.ts";

export type Permissions = "read" | "exec";

/** The latest adapter versions that passed the smoke test. A member can pin another version with `command`. */
export const ADAPTERS: Record<AgentName, string> = {
  claude: "@agentclientprotocol/claude-agent-acp@0.91.0",
  codex: "@agentclientprotocol/codex-acp@2.2.2",
  pi: "pi-acp@0.0.34",
};

export type LaunchPlan = {
  agent: AgentName | null;
  command: string[];
  env: Record<string, string>;
  sessionMeta: Record<string, unknown> | undefined;
  /** Session config options that the agent profile sets, such as a read-only mode. */
  configOptions: Record<string, string>;
  /** Tool kinds that the permission policy also allows, because the agent enforces the same limit itself. */
  allowKinds: ToolKind[];
  /** Whether the member runs without the user's own instructions, skills and extensions. `null` is not known. */
  clean: boolean | null;
  cleanNote: string;
};

type Profile = (
  permissions: Permissions,
  scratchDir: string,
  member: MemberConfig,
) => Promise<Omit<LaunchPlan, "agent" | "command">>;

const CLAUDE_TOOLS: Record<Permissions, string[]> = {
  read: ["Read", "Grep", "Glob"],
  exec: ["Read", "Grep", "Glob", "Bash"],
};

const PI_TOOLS: Record<Permissions, string> = {
  read: "read,grep,find,ls",
  exec: "read,grep,find,ls,bash",
};

const PROFILES: Record<AgentName, Profile> = {
  claude: (permissions) =>
    Promise.resolve({
      env: {},
      sessionMeta: { claudeCode: { options: { settingSources: [], tools: CLAUDE_TOOLS[permissions] } } },
      configOptions: {},
      allowKinds: [],
      clean: true,
      cleanNote: "Claude Code runs with no setting sources: no user or project settings, CLAUDE.md files or skills.",
    }),
  codex: (permissions) =>
    Promise.resolve({
      env: {},
      sessionMeta: undefined,
      configOptions: { mode: permissions === "read" ? "read-only" : "workspace-write" },
      // Codex reads files with shell commands. Its read-only sandbox blocks writes and network access itself.
      allowKinds: ["execute"],
      clean: false,
      cleanNote:
        "Codex reads its home folder, which holds both the login and the user's instructions. acp-council does not copy the login, so the user's instructions stay on.",
    }),
  pi: async (permissions, scratchDir, member) => {
    const extensions = (member.extensions ?? []).map(expandHome);
    const wrapper = join(scratchDir, "pi-clean.sh");
    const flags = [
      "--no-extensions",
      ...extensions.flatMap((path) => ["-e", shellQuote(path)]),
      "--no-skills --no-context-files --no-prompt-templates",
      `--tools ${PI_TOOLS[permissions]}`,
    ];
    await writeFile(wrapper, `#!/bin/sh\nexec pi ${flags.join(" ")} "$@"\n`);
    await chmod(wrapper, 0o755);
    const loaded = extensions.length === 0 ? "no extensions" : `only these extensions: ${extensions.join(", ")}`;
    return {
      env: { PI_ACP_PI_COMMAND: wrapper },
      sessionMeta: undefined,
      configOptions: {},
      allowKinds: [],
      clean: true,
      cleanNote: `Pi runs with ${loaded}, and no skills, context files or prompt templates.`,
    };
  },
};

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

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
  const profile = await PROFILES[member.agent](permissions, scratchDir, member);
  return {
    agent: member.agent,
    command: member.command ?? ["npx", "-y", ADAPTERS[member.agent]],
    ...profile,
  };
}
