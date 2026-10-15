import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile, Permissions } from "./profile.ts";

const TOOLS: Record<Permissions, string> = {
  read: "read,grep,find,ls",
  exec: "read,grep,find,ls,bash",
};

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Pi through pi-acp. pi-acp starts `pi` itself, so the profile points it at a wrapper script that turns off
 * extensions, skills, context files and prompt templates. A member can name extensions to load, such as a provider.
 */
export const pi: AgentProfile = {
  name: "pi",
  adapter: "pi-acp@0.0.34",
  session: async ({ member, permissions, scratchDir }) => {
    const extensions = (member.extensions ?? []).map(expandHome);
    const flags = [
      "--no-extensions",
      ...extensions.flatMap((path) => ["-e", shellQuote(path)]),
      "--no-skills --no-context-files --no-prompt-templates",
      `--tools ${TOOLS[permissions]}`,
    ];
    const wrapper = join(scratchDir, "pi-clean.sh");
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
