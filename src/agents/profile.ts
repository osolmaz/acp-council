import type { ToolKind } from "@agentclientprotocol/sdk";
import type { AgentName, MemberConfig } from "../config/schema.ts";

export type Permissions = "read" | "exec";

/** Everything needed to start one member: the adapter command and how its session runs. */
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

export type ProfileContext = {
  member: MemberConfig;
  permissions: Permissions;
  /** A private folder for files the launch needs, such as a wrapper script. */
  scratchDir: string;
};

/** A built-in agent: its pinned ACP adapter, and how to run it clean under a permission level. */
export type AgentProfile = {
  name: AgentName;
  adapter: string;
  session: (context: ProfileContext) => Promise<Omit<LaunchPlan, "agent" | "command">>;
};
