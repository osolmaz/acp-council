import { z } from "zod";
import type { ItemVote, Vote } from "./types.ts";

export type VoteSchema = {
  /** The caller's JSON Schema for one item's vote. */
  jsonSchema: Record<string, unknown>;
  /** The allowed choices, when the schema lists them in `properties.choice.enum`. */
  choices: string[] | null;
  validator: z.ZodType;
};

export type VoteCheck = { ok: true; vote: Vote; body: string } | { ok: false; errors: string[] };

export const DEFAULT_VOTE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    choice: { type: "string" },
    reason: { type: "string" },
  },
  required: ["choice", "reason"],
};

const baseItemVote = z.looseObject({ choice: z.string().min(1), reason: z.string().min(1) });

const recordSchema = z.record(z.string(), z.unknown());

const choiceEnum = z.object({
  properties: z.object({ choice: z.object({ enum: z.array(z.string()).min(1) }) }),
});

export function compileVoteSchema(jsonSchema: Record<string, unknown> = DEFAULT_VOTE_SCHEMA): VoteSchema {
  const listed = choiceEnum.safeParse(jsonSchema);
  return {
    jsonSchema,
    choices: listed.success ? listed.data.properties.choice.enum : null,
    validator: z.fromJSONSchema(jsonSchema),
  };
}

const FENCED_BLOCK = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Finds the last fenced block of a reply and parses it as JSON. The rest of the reply is the body. */
export function extractJsonBlock(
  text: string,
): { ok: true; body: string; json: unknown } | { ok: false; error: string } {
  const blocks = [...text.matchAll(FENCED_BLOCK)];
  const last = blocks.at(-1);
  if (last === undefined) {
    return { ok: false, error: "the reply has no fenced JSON block" };
  }
  const body = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  try {
    return { ok: true, body, json: JSON.parse(last[1] ?? "") as unknown };
  } catch (error) {
    return { ok: false, error: `the last fenced block is not valid JSON: ${describeError(error)}` };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(prefix: string, issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${prefix}${path === "" ? "" : `.${path}`}: ${issue.message}`;
  });
}

function checkItemVote(id: string, value: unknown, schema: VoteSchema): { vote?: ItemVote; errors: string[] } {
  if (value === undefined) {
    return { errors: [`${id}: the block has no vote for this item`] };
  }
  const base = baseItemVote.safeParse(value);
  const custom = schema.validator.safeParse(value);
  const errors = [
    ...(base.success ? [] : formatIssues(id, base.error.issues)),
    ...(custom.success ? [] : formatIssues(id, custom.error.issues)),
  ];
  if (!base.success || errors.length > 0) {
    return { errors };
  }
  const { choice, reason, ...fields } = base.data;
  return { vote: Object.keys(fields).length > 0 ? { choice, reason, fields } : { choice, reason }, errors: [] };
}

/**
 * Checks the vote block at the end of a reply. The block must hold a valid vote for every open item.
 * Votes on other items, such as items that closed in an earlier round, are ignored.
 */
export function checkVote(text: string, openItems: string[], schema: VoteSchema): VoteCheck {
  const block = extractJsonBlock(text);
  if (!block.ok) {
    return { ok: false, errors: [block.error] };
  }
  const parsed = recordSchema.safeParse(block.json);
  if (!parsed.success) {
    return { ok: false, errors: ["the vote block must be a JSON object that maps item IDs to votes"] };
  }
  const errors: string[] = [];
  const vote: Vote = {};
  for (const id of openItems) {
    const result = checkItemVote(id, parsed.data[id], schema);
    errors.push(...result.errors);
    if (result.vote !== undefined) {
      vote[id] = result.vote;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, vote, body: block.body };
}
