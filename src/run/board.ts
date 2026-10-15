import { messageId } from "../domain/board.ts";
import type { Message } from "../domain/types.ts";
import type { RoundRecord } from "./store.ts";

/**
 * The board, derived from the saved rounds: every member's message from every round that has ended, in round and
 * label order. Because it is derived, a resumed run rebuilds the same board with the same message IDs.
 */
export function boardFromRecords(records: RoundRecord[], lastEndedRound: number): Message[] {
  return records
    .filter((record) => record.round <= lastEndedRound && record.body !== "")
    .sort((a, b) => a.round - b.round || a.label.localeCompare(b.label))
    .map((record, index) => ({
      id: messageId(index),
      round: record.round,
      from: record.label,
      refs: [],
      body: record.body,
      vote: record.vote ?? {},
      createdAt: record.endedAt,
    }));
}
