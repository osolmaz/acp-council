import { AcpSession, type SessionHooks, type SessionInfo, type SessionSpec } from "../acp/session.ts";
import type { ModeRules } from "../domain/modes.ts";
import { buildTurnPrompt, type Intro } from "../domain/prompts.ts";
import type { Message } from "../domain/types.ts";
import type { VoteSchema } from "../domain/vote.ts";
import type { RoundRecord } from "./store.ts";
import { castVote, failedAttempt, roundRecord, type Ballot } from "./turn.ts";

export type RoundContext = {
  round: number;
  openItems: string[];
  board: Message[];
  timeoutMs: number;
};

/**
 * A seat on the council. It owns the member's ACP session, opens a new one when the adapter has stopped, and tracks
 * which board messages the current session has seen, so that each turn sends only what is new.
 */
export class Member {
  readonly spec: SessionSpec;
  private readonly intro: Intro;
  private readonly schema: VoteSchema;
  private readonly hooks: SessionHooks;
  private session: AcpSession | null = null;
  private seen = new Set<string>();
  info: SessionInfo | null = null;

  constructor(spec: SessionSpec, intro: Intro, schema: VoteSchema, hooks: SessionHooks) {
    this.spec = spec;
    this.intro = intro;
    this.schema = schema;
    this.hooks = hooks;
  }

  get label(): string {
    return this.spec.label;
  }

  /** The current session, or a new one. A new session must be told the question and the board again. */
  private async ensureSession(): Promise<{ session: AcpSession; fresh: boolean }> {
    if (this.session?.alive === true) {
      return { session: this.session, fresh: false };
    }
    this.session = await AcpSession.open(this.spec, this.hooks);
    this.info = this.session.info;
    this.seen = new Set();
    return { session: this.session, fresh: true };
  }

  async turn(mode: ModeRules, context: RoundContext): Promise<RoundRecord> {
    const ballot: Ballot = {
      label: this.label,
      round: context.round,
      openItems: context.openItems,
      schema: this.schema,
      timeoutMs: context.timeoutMs,
    };
    try {
      const { session, fresh } = await this.ensureSession();
      const viewer = { label: this.label, round: context.round, freshSession: fresh };
      const messages = context.board.filter((m) => !this.seen.has(m.id) && mode.visible(m, viewer));
      const prompt = buildTurnPrompt({
        ...(fresh ? { intro: this.intro } : {}),
        messages,
        instruction: mode.instruction(context.round, context.openItems),
        label: this.label,
      });
      const record = await castVote(session, prompt, ballot);
      messages.forEach((m) => this.seen.add(m.id));
      return record;
    } catch (error) {
      return roundRecord(ballot, { status: "no_result", body: "", vote: null }, [failedAttempt(error)]);
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = null;
  }
}
