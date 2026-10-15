import {
  MemberConnection,
  type MemberHooks,
  type MemberInfo,
  type MemberSpec,
  type TurnOutcome,
} from "../acp/client.ts";
import { visibleMessages } from "../domain/board.ts";
import { buildNudgePrompt, buildTurnPrompt, type Intro } from "../domain/prompts.ts";
import type { Message } from "../domain/types.ts";
import { checkVote, type VoteSchema } from "../domain/vote.ts";
import type { Attempt, RoundRecord } from "./store.ts";

export type TurnContext = {
  round: number;
  openItems: string[];
  board: Message[];
  timeoutMs: number;
};

export type Connector = (spec: MemberSpec, hooks: MemberHooks) => Promise<MemberConnection>;

/** A member during a run: its adapter connection, and the board messages its current session has seen. */
export class Member {
  readonly spec: MemberSpec;
  private readonly intro: Intro;
  private readonly schema: VoteSchema;
  private readonly hooks: MemberHooks;
  private readonly connect: Connector;
  private connection: MemberConnection | null = null;
  private seen = new Set<string>();
  info: MemberInfo | null = null;

  constructor(spec: MemberSpec, intro: Intro, schema: VoteSchema, hooks: MemberHooks, connect?: Connector) {
    this.spec = spec;
    this.intro = intro;
    this.schema = schema;
    this.hooks = hooks;
    this.connect = connect ?? ((s, h) => MemberConnection.open(s, h));
  }

  get label(): string {
    return this.spec.label;
  }

  /** Opens a new session when there is none or the adapter has stopped. A new session must be told everything again. */
  private async session(): Promise<{ connection: MemberConnection; fresh: boolean }> {
    if (this.connection?.alive === true) {
      return { connection: this.connection, fresh: false };
    }
    this.connection = await this.connect(this.spec, this.hooks);
    this.info = this.connection.info;
    this.seen = new Set();
    return { connection: this.connection, fresh: true };
  }

  async turn(context: TurnContext): Promise<RoundRecord> {
    const attempts: Attempt[] = [];
    try {
      const { connection, fresh } = await this.session();
      const messages = visibleMessages(context.board, this.label, context.round, fresh).filter(
        (m) => !this.seen.has(m.id),
      );
      const prompt = buildTurnPrompt({
        ...(fresh ? { intro: this.intro } : {}),
        messages,
        round: context.round,
        openItems: context.openItems,
        label: this.label,
      });
      const record = await this.vote(connection, prompt, context, attempts);
      messages.forEach((m) => this.seen.add(m.id));
      return record;
    } catch (error) {
      attempts.push(failedAttempt(error));
      return this.record(context.round, "no_result", "", null, attempts);
    }
  }

  private async vote(
    connection: MemberConnection,
    prompt: string,
    context: TurnContext,
    attempts: Attempt[],
  ): Promise<RoundRecord> {
    const first = await connection.prompt(prompt, context.timeoutMs);
    const firstCheck = first.status === "done" ? checkVote(first.text, context.openItems, this.schema) : null;
    attempts.push(attempt(prompt, first, firstCheck));
    if (firstCheck === null) {
      return this.record(context.round, "no_result", first.text, null, attempts);
    }
    if (firstCheck.ok) {
      return this.record(context.round, "voted", firstCheck.body, firstCheck.vote, attempts);
    }
    const nudge = buildNudgePrompt(firstCheck.errors, context.openItems);
    const second = await connection.prompt(nudge, context.timeoutMs);
    const secondCheck = second.status === "done" ? checkVote(second.text, context.openItems, this.schema) : null;
    attempts.push(attempt(nudge, second, secondCheck));
    if (secondCheck?.ok !== true) {
      return this.record(context.round, "no_result", first.text, null, attempts);
    }
    return this.record(
      context.round,
      "voted",
      secondCheck.body === "" ? first.text : secondCheck.body,
      secondCheck.vote,
      attempts,
    );
  }

  private record(
    round: number,
    status: RoundRecord["status"],
    body: string,
    vote: RoundRecord["vote"],
    attempts: Attempt[],
  ): RoundRecord {
    return { round, label: this.label, status, body, vote, attempts, endedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
  }
}

function attempt(prompt: string, outcome: TurnOutcome, check: ReturnType<typeof checkVote> | null): Attempt {
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

function failedAttempt(error: unknown): Attempt {
  return {
    prompt: "",
    text: "",
    status: "error",
    stopReason: null,
    totalTokens: null,
    error: error instanceof Error ? error.message : String(error),
    voteErrors: [],
    durationMs: 0,
  };
}
