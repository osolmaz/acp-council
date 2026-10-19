import type { AcpSession, TurnOutcome } from "../acp/session.ts";
import { buildNudgePrompt } from "../domain/prompts.ts";
import { checkVote, type VoteCheck, type VoteSchema } from "../domain/vote.ts";
import { errorMessage } from "../util/async.ts";
import type { Attempt, RoundRecord } from "./store.ts";

export type Ballot = {
  label: string;
  round: number;
  openItems: string[];
  schema: VoteSchema;
  timeoutMs: number;
};

function attempt(prompt: string, outcome: TurnOutcome, check: VoteCheck | null): Attempt {
  return {
    prompt,
    text: outcome.text,
    status: outcome.status,
    stopReason: outcome.stopReason,
    totalTokens: outcome.usage?.totalTokens ?? null,
    usage: outcome.usage,
    error: outcome.error,
    voteErrors: check === null || check.ok ? [] : check.errors,
    durationMs: outcome.durationMs,
  };
}

export function failedAttempt(error: unknown): Attempt {
  return {
    prompt: "",
    text: "",
    status: "error",
    stopReason: null,
    totalTokens: null,
    error: errorMessage(error),
    voteErrors: [],
    durationMs: 0,
  };
}

export function roundRecord(
  ballot: Ballot,
  result: Pick<RoundRecord, "status" | "body" | "vote">,
  attempts: Attempt[],
): RoundRecord {
  return { round: ballot.round, label: ballot.label, ...result, attempts, endedAt: new Date().toISOString() };
}

async function ask(
  session: AcpSession,
  prompt: string,
  ballot: Ballot,
): Promise<{ attempt: Attempt; check: VoteCheck | null; text: string }> {
  const outcome = await session.prompt(prompt, ballot.timeoutMs);
  const check =
    outcome.status === "done" || outcome.text.length > 0
      ? checkVote(outcome.text, ballot.openItems, ballot.schema)
      : null;
  return { attempt: attempt(prompt, outcome, check), check, text: outcome.text };
}

/**
 * One member's turn in one round: the prompt, and one nudge in the same session when the vote block is invalid.
 * A turn that still has no valid vote records `no_result`.
 */
export async function castVote(session: AcpSession, prompt: string, ballot: Ballot): Promise<RoundRecord> {
  if (session.budget) return castBoundedVote(session, prompt, ballot);
  const first = await ask(session, prompt, ballot);
  if (first.check?.ok === true) {
    return roundRecord(ballot, { status: "voted", body: first.check.body, vote: first.check.vote }, [first.attempt]);
  }
  if (first.check === null) {
    return roundRecord(ballot, { status: "no_result", body: first.text, vote: null }, [first.attempt]);
  }
  const second = await ask(session, buildNudgePrompt(first.check.errors, ballot.openItems), ballot);
  const attempts = [first.attempt, second.attempt];
  if (second.check?.ok !== true) {
    return roundRecord(ballot, { status: "no_result", body: first.text, vote: null }, attempts);
  }
  const body = second.check.body === "" ? first.text : second.check.body;
  return roundRecord(ballot, { status: "voted", body, vote: second.check.vote }, attempts);
}

/** Reminders interrupt only this owned turn, then continue the same ACP session. */
async function castBoundedVote(session: AcpSession, prompt: string, ballot: Ballot): Promise<RoundRecord> {
  const budget = session.budget;
  if (!budget) throw new Error("missing member budget");
  const attempts: Attempt[] = [];
  const reminders = new Set<number>();
  let text = "";
  while (canContinue(session)) {
    const phase = budget.phase();
    const remaining = budget.remaining(phase);
    const reminder = nextReminder(budget.limits.workSec, remaining, reminders, phase);
    const duration = reminder === null ? remaining : Math.max(1, remaining - reminder * 1000);
    const asked = await ask(session, prompt, { ...ballot, timeoutMs: duration });
    attempts.push(asked.attempt);
    text += asked.text;
    if (asked.check?.ok)
      return roundRecord(ballot, { status: "voted", body: asked.check.body, vote: asked.check.vote }, attempts);
    if (isReminder(reminder, asked.attempt.status, budget.phase())) {
      prompt = reminderPrompt(reminder, reminders);
      continue;
    }
    if (budget.phase() === phase) budget.advance();
    prompt =
      "Investigation has ended. Do not read or search further. Submit your vote now using only evidence already gathered. Preserve supported partial findings; never invent votes for unchecked items.";
  }
  return roundRecord(ballot, { status: "no_result", body: text, vote: null }, attempts);
}

function nextReminder(workSec: number, remaining: number, sent: Set<number>, phase: string): number | null {
  if (phase !== "work") return null;
  const values = [workSec / 2, 300, 120, 60].filter(
    (value) => value < workSec && value * 1000 < remaining && !sent.has(value),
  );
  return values.length === 0 ? null : Math.max(...values);
}

function canContinue(session: AcpSession): boolean {
  return (
    session.alive && session.budget !== undefined && session.budget.phase() !== "stopped" && !session.budget.exhausted()
  );
}
function isReminder(reminder: number | null, status: string, phase: string): boolean {
  return reminder !== null && status === "timeout" && phase === "work";
}

function reminderPrompt(reminder: number | null, sent: Set<number>): string {
  if (reminder === null) throw new Error("missing reminder");
  sent.add(reminder);
  return `Time reminder: ${reminder / 60} minutes left for investigation. Continue from your existing findings and submit your complete vote before the deadline.`;
}
