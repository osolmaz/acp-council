import { z } from "zod";

export const AGENT_NAMES = ["claude", "codex", "pi"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export const memberSchema = z
  .strictObject({
    /** A built-in agent. It sets the adapter command and how the member runs clean. */
    agent: z.enum(AGENT_NAMES).optional(),
    /** The adapter command. It replaces the built-in command, for example to pin another adapter version. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** A value of the agent's model option, or its display name. */
    model: z.string().min(1).optional(),
    /** Other session config options of the agent, such as a reasoning effort. */
    options: z.record(z.string(), z.string()).optional(),
    /** Pi only: the extension files to load, such as a model provider. Every other extension stays off. */
    extensions: z.array(z.string().min(1)).optional(),
  })
  .refine((member) => member.agent !== undefined || member.command !== undefined, {
    message: "a member needs an agent or a command",
  })
  .refine((member) => member.extensions === undefined || member.agent === "pi", {
    message: "only a Pi member can list extensions",
  });

export type MemberConfig = z.infer<typeof memberSchema>;

export const membersFileSchema = z.record(z.string().min(1), memberSchema);

export const MIN_ROUNDS = 5;

export const councilFileSchema = z.strictObject({
  mode: z.enum(["blind", "discuss"]).default("blind"),
  members: z.array(z.string().min(1)).min(1),
  rounds: z.number().int().min(MIN_ROUNDS).default(MIN_ROUNDS),
  rule: z.enum(["unanimous", "majority"]).default("unanimous"),
  /** A JSON Schema file for one item's vote, relative to the council file. */
  schema: z.string().min(1).optional(),
  /** A default question file, relative to the council file. */
  question: z.string().min(1).optional(),
  permissions: z.enum(["read", "exec"]).default("read"),
  turnTimeoutSec: z.number().int().positive().default(1800),
  concurrency: z.number().int().positive().default(3),
  limits: z
    .strictObject({
      maxRunSec: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .default({}),
});

export type CouncilFile = z.infer<typeof councilFileSchema>;

export const itemsFileSchema = z
  .array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), text: z.string() }))
  .min(1)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: "item IDs must be unique",
  });
