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
  const check = outcome.status === "done" ? checkVote(outcome.text, ballot.openItems, ballot.schema) : null;
  return { attempt: attempt(prompt, outcome, check), check, text: outcome.text };
}

/**
 * One member's turn in one round: the prompt, and one nudge in the same session when the vote block is invalid.
 * A turn that still has no valid vote records `no_result`.
 */
export async function castVote(session: AcpSession, prompt: string, ballot: Ballot): Promise<RoundRecord> {
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
