import { join } from "node:path";
import type { ResolvedJury } from "../config/load.ts";
import { memberLabel } from "../domain/board.ts";
import { juryResult, startJury } from "../domain/jury.ts";
import { MODES } from "../domain/modes.ts";
import type { JuryResult, Item } from "../domain/types.ts";
import { compileVoteSchema } from "../domain/vote.ts";
import { assertResumable, hashInputs, newRunId } from "./inputs.ts";
import { backupRun, writeResult, writeRunJson, type RunHeader } from "./outputs.ts";
import { RoundLoop, type Progress, type StopReason } from "./rounds.ts";
import { seatMembers, type SeatedMember } from "./seats.ts";
import { RunStore } from "./store.ts";
import { Workspace } from "./workspace.ts";

export type RunOptions = {
  jury: ResolvedJury;
  /** The read-only folder. Each member works in its own copy. */
  folder: string;
  question: string;
  /** The items to vote on. Without items, the jury votes once on the item `answer`. */
  items?: Item[] | undefined;
  /** The parent folder of the run folder. */
  outDir: string;
  /** A rerun with the same run ID resumes the run and skips saved turns. */
  runId?: string;
  onProgress?: (progress: Progress) => void;
  /** Called with the run folder when the run ends, after a key scan of the folder finds no key. */
  backup?: (runDir: string) => Promise<void>;
};

export type RunOutcome = {
  runId: string;
  runDir: string;
  stop: StopReason;
  result: JuryResult;
};

const ANSWER_ITEM: Item = { id: "answer", text: "" };

/**
 * Runs a jury: it seats the members, plays the rounds of the jury's mode, and writes the run folder.
 * The members' sessions and private folders are always cleaned up, also when the run fails.
 */
export async function runJury(options: RunOptions): Promise<RunOutcome> {
  const { jury, folder, question } = options;
  const items = options.items ?? [ANSWER_ITEM];
  const runId = options.runId ?? newRunId();
  const store = new RunStore(join(options.outDir, runId));
  const labels = jury.members.map((_, index) => memberLabel(index));
  const inputs = await hashInputs(jury, question, items, folder);
  const header: RunHeader = { runId, jury, question, folder, inputs };
  const schema = compileVoteSchema(jury.schema?.json);
  await store.init(labels);
  await assertResumable(store, inputs);
  const workspace = await Workspace.create();
  const seats: SeatedMember[] = [];
  let outcome: { stop: StopReason; result: JuryResult };
  try {
    seats.push(...(await seatMembers({ jury, labels, folder, question, items, schema }, workspace, store)));
    await writeRunJson(store, header, seats);
    const { settings } = jury;
    const state = startJury({ mode: settings.mode, rule: settings.rule, rounds: settings.rounds, items, labels });
    const loop = new RoundLoop({
      seats,
      mode: MODES[settings.mode],
      state,
      store,
      settings,
      saved: await store.loadAllRounds(labels),
      onProgress: options.onProgress,
    });
    outcome = { stop: await loop.run(), result: juryResult(state) };
    await writeRunJson(store, header, seats);
    await writeResult(store, header, seats, outcome);
  } finally {
    await Promise.all(seats.map((seat) => seat.member.close()));
    await store.close();
    await workspace.remove();
  }
  await backupRun(store.dir, options.backup);
  return { runId, runDir: store.dir, ...outcome };
}
