import { applyRound, nextRound, type CouncilState } from "../domain/council.ts";
import type { ModeRules } from "../domain/modes.ts";
import type { Vote } from "../domain/types.ts";
import { pool } from "../util/async.ts";
import { boardFromRecords } from "./board.ts";
import { limitReached, type LimitReason } from "./limits.ts";
import type { Member } from "./member.ts";
import type { RoundRecord, RunStore } from "./store.ts";
import type { CouncilFile } from "../config/schema.ts";

export type StopReason = "all_agreed" | "rounds_done" | LimitReason;

export type Progress =
  | { type: "round"; round: number; openItems: string[] }
  | { type: "turn"; round: number; label: string; name: string; status: RoundRecord["status"]; reused: boolean };

export type Seat = { member: Member; name: string };

export type RoundLoopOptions = {
  seats: Seat[];
  mode: ModeRules;
  state: CouncilState;
  store: RunStore;
  settings: CouncilFile;
  /** Rounds saved by an earlier run with the same ID. They are reused, not played again. */
  saved: RoundRecord[];
  onProgress?: ((progress: Progress) => void) | undefined;
};

function key(label: string, round: number): string {
  return `${label}#${round}`;
}

/** Plays rounds until the mode ends the run, every item is closed, or a limit is reached. */
export class RoundLoop {
  private readonly options: RoundLoopOptions;
  private readonly saved: Map<string, RoundRecord>;
  private readonly records: RoundRecord[] = [];
  private readonly startedAt = Date.now();

  constructor(options: RoundLoopOptions) {
    this.options = options;
    this.saved = new Map(options.saved.map((record) => [key(record.label, record.round), record]));
  }

  async run(): Promise<StopReason> {
    const { state, settings } = this.options;
    for (let next = nextRound(state); next !== null; next = nextRound(state)) {
      const limit = limitReached(settings.limits, this.startedAt, this.records);
      if (limit !== null) {
        return limit;
      }
      await this.play(next.round, next.openItems);
    }
    return state.open.length === 0 ? "all_agreed" : "rounds_done";
  }

  private async play(round: number, openItems: string[]): Promise<void> {
    const { seats, store, settings, onProgress } = this.options;
    onProgress?.({ type: "round", round, openItems });
    const board = boardFromRecords(this.records, round - 1);
    const tasks = seats.map(
      (seat) => () => this.turn(seat, { round, openItems, board, timeoutMs: settings.turnTimeoutSec * 1000 }),
    );
    const records = await pool(tasks, settings.concurrency);
    this.records.push(...records);
    const votes = new Map<string, Vote | undefined>(records.map((record) => [record.label, record.vote ?? undefined]));
    applyRound(this.options.state, round, votes);
    await store.writeBoard(boardFromRecords(this.records, round));
  }

  private async turn(seat: Seat, context: Parameters<Member["turn"]>[1]): Promise<RoundRecord> {
    const saved = this.saved.get(key(seat.member.label, context.round));
    const record = saved ?? (await seat.member.turn(this.options.mode, context));
    if (saved === undefined) {
      await this.options.store.saveRound(record);
    }
    this.options.onProgress?.({
      type: "turn",
      round: context.round,
      label: seat.member.label,
      name: seat.name,
      status: record.status,
      reused: saved !== undefined,
    });
    return record;
  }
}
