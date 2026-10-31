import type { CouncilFile } from "../config/schema.ts";
import type { RoundRecord } from "./store.ts";

export type LimitReason = "time_limit" | "token_limit";

export function totalTokens(records: RoundRecord[]): number {
  return records.flatMap((record) => record.attempts).reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
}

/** The run's limits are checked between rounds, so a round that has started always ends. */
export function limitReached(
  limits: CouncilFile["limits"],
  startedAt: number,
  records: RoundRecord[],
): LimitReason | null {
  if (limits.maxRunSec !== undefined && Date.now() - startedAt >= limits.maxRunSec * 1000) {
    return "time_limit";
  }
  if (limits.maxTokens !== undefined && totalTokens(records) >= limits.maxTokens) {
    return "token_limit";
  }
  return null;
}
