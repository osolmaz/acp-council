import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLaunch, type LaunchPlan } from "../acp/agents.ts";
import type { MemberHooks } from "../acp/client.ts";
import type { ResolvedCouncil } from "../config/load.ts";
import { memberLabel, messageId } from "../domain/board.ts";
import { applyRound, councilResult, nextRound, startCouncil, type CouncilState } from "../domain/council.ts";
import { renderReport } from "../domain/report.ts";
import type { CouncilResult, Item, Message, Vote } from "../domain/types.ts";
import { compileVoteSchema, DEFAULT_VOTE_SCHEMA } from "../domain/vote.ts";
import { VERSION } from "../meta/version.ts";
import { copyFolder, hashFolder, scanForKeys, sha256 } from "./files.ts";
import { Member, type Connector } from "./member.ts";
import { RunStore, type RoundRecord } from "./store.ts";

export type Progress =
  | { type: "round"; round: number; openItems: string[] }
  | { type: "turn"; round: number; label: string; name: string; status: RoundRecord["status"]; reused: boolean };

export type RunOptions = {
  council: ResolvedCouncil;
  /** The read-only folder. Each member works in its own copy. */
  folder: string;
  question: string;
  /** The items to vote on. Without items, the council votes once on the item `answer`. */
  items?: Item[];
  /** The parent folder of the run folder. */
  outDir: string;
  /** A rerun with the same run ID resumes the run and skips saved turns. */
  runId?: string;
  onProgress?: (progress: Progress) => void;
  /** Called with the run folder when the run ends, after a key scan of the folder finds no key. */
  backup?: (runDir: string) => Promise<void>;
  /** Replaces the ACP connection, for tests. */
  connect?: Connector;
};

export type StopReason = "all_agreed" | "rounds_done" | "time_limit" | "token_limit";

export type RunOutcome = {
  runId: string;
  runDir: string;
  stop: StopReason;
  result: CouncilResult;
};

type Limits = ResolvedCouncil["council"]["limits"];

export class RunError extends Error {
  override name = "RunError";
}

export function newRunId(now = new Date()): string {
  return `${now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
}

const ANSWER_ITEM: Item = { id: "answer", text: "" };

async function inputHashes(options: RunOptions, items: Item[]): Promise<Record<string, string>> {
  return {
    question: sha256(options.question),
    items: sha256(JSON.stringify(items)),
    council: sha256(JSON.stringify(options.council.council)),
    members: sha256(JSON.stringify(options.council.members)),
    schema: sha256(JSON.stringify(options.council.schema?.json ?? DEFAULT_VOTE_SCHEMA)),
    folder: await hashFolder(options.folder),
  };
}

async function checkResume(store: RunStore, inputs: Record<string, string>): Promise<void> {
  const previous = (await store.readJson("run.json")) as { inputs?: unknown } | null;
  if (previous !== null && JSON.stringify(previous.inputs) !== JSON.stringify(inputs)) {
    throw new RunError(`the run folder ${store.dir} holds a run with other inputs; use another run ID`);
  }
}

/** The board is derived from the saved rounds: every member's message from every round that has ended. */
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

function totalTokens(records: RoundRecord[]): number {
  return records.flatMap((record) => record.attempts).reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
}

function limitReached(limits: Limits, startedAt: number, records: RoundRecord[]): StopReason | null {
  if (limits.maxRunSec !== undefined && Date.now() - startedAt >= limits.maxRunSec * 1000) {
    return "time_limit";
  }
  if (limits.maxTokens !== undefined && totalTokens(records) >= limits.maxTokens) {
    return "token_limit";
  }
  return null;
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

type Prepared = {
  members: Member[];
  plans: LaunchPlan[];
  scratch: string;
};

async function prepareMembers(
  options: RunOptions,
  store: RunStore,
  items: Item[],
  labels: string[],
): Promise<Prepared> {
  const { council } = options;
  const scratch = await mkdtemp(join(tmpdir(), "acp-council-"));
  const schema = compileVoteSchema(council.schema?.json);
  const plans: LaunchPlan[] = [];
  const members: Member[] = [];
  for (const [index, member] of council.members.entries()) {
    const label = labels[index] ?? memberLabel(index);
    const memberScratch = join(scratch, label.replace("member:", ""));
    const workDir = join(memberScratch, "folder");
    await mkdir(memberScratch, { recursive: true });
    await copyFolder(options.folder, workDir);
    const plan = await planLaunch(member.config, council.council.permissions, memberScratch);
    plans.push(plan);
    const hooks: MemberHooks = {
      onEvent: ((write) => (event: Record<string, unknown>) => {
        write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      })(store.log(label, "events.ndjson")),
      onStderr: store.log(label, "stderr.log"),
    };
    const intro = { label, memberCount: council.members.length, question: options.question, items, schema };
    const spec = {
      label,
      plan,
      model: member.config.model,
      options: member.config.options ?? {},
      workDir,
      permissions: council.council.permissions,
      startTimeoutMs: 300_000,
    };
    members.push(new Member(spec, intro, schema, hooks, options.connect));
  }
  return { members, plans, scratch };
}

function runMeta(
  options: RunOptions,
  runId: string,
  labels: string[],
  plans: LaunchPlan[],
  members: Member[],
): Record<string, unknown> {
  const { council } = options;
  return {
    runId,
    acpCouncilVersion: VERSION,
    council: {
      name: council.name,
      level: council.level,
      path: council.path,
      membersPath: council.membersPath,
      ...council.council,
    },
    question: options.question,
    folder: options.folder,
    members: council.members.map((member, index) => ({
      label: labels[index],
      name: member.name,
      config: member.config,
      command: plans[index]?.command,
      clean: plans[index]?.clean,
      cleanNote: plans[index]?.cleanNote,
      session: members[index]?.info ?? null,
    })),
  };
}

type Loop = {
  options: RunOptions;
  store: RunStore;
  members: Member[];
  state: CouncilState;
  saved: Map<string, RoundRecord>;
  records: RoundRecord[];
  startedAt: number;
};

function key(label: string, round: number): string {
  return `${label}#${round}`;
}

async function playRound(loop: Loop, round: number, openItems: string[]): Promise<void> {
  const { options, store, members } = loop;
  options.onProgress?.({ type: "round", round, openItems });
  const board = boardFromRecords(loop.records, round - 1);
  const timeoutMs = options.council.council.turnTimeoutSec * 1000;
  const tasks = members.map((member, index) => async (): Promise<RoundRecord> => {
    const saved = loop.saved.get(key(member.label, round));
    const record = saved ?? (await member.turn({ round, openItems, board, timeoutMs }));
    if (saved === undefined) {
      await store.saveRound(record);
    }
    const name = options.council.members[index]?.name ?? member.label;
    options.onProgress?.({
      type: "turn",
      round,
      label: member.label,
      name,
      status: record.status,
      reused: saved !== undefined,
    });
    return record;
  });
  const records = await pool(tasks, options.council.council.concurrency);
  loop.records.push(...records);
  const votes = new Map<string, Vote | undefined>(records.map((record) => [record.label, record.vote ?? undefined]));
  applyRound(loop.state, round, votes);
  await store.writeBoard(boardFromRecords(loop.records, round));
}

async function playRounds(loop: Loop): Promise<StopReason> {
  for (let next = nextRound(loop.state); next !== null; next = nextRound(loop.state)) {
    const limit = limitReached(loop.options.council.council.limits, loop.startedAt, loop.records);
    if (limit !== null) {
      return limit;
    }
    await playRound(loop, next.round, next.openItems);
  }
  return loop.state.open.length === 0 ? "all_agreed" : "rounds_done";
}

async function loadSaved(store: RunStore, labels: string[]): Promise<Map<string, RoundRecord>> {
  const saved = new Map<string, RoundRecord>();
  for (const label of labels) {
    for (const record of await store.loadRounds(label)) {
      saved.set(key(label, record.round), record);
    }
  }
  return saved;
}

async function finish(
  options: RunOptions,
  store: RunStore,
  runId: string,
  outcome: { stop: StopReason; result: CouncilResult },
  labels: string[],
): Promise<void> {
  const { result } = outcome;
  await store.writeJson("result.json", { stop: outcome.stop, ...result });
  await store.writeText(
    "report.md",
    renderReport({
      runId,
      council: options.council.name,
      maxRounds: options.council.council.rounds,
      members: options.council.members.map((member, index) => ({
        label: labels[index] ?? "",
        name: member.name,
        agent: member.config.agent ?? "custom",
        model: member.config.model ?? "default",
      })),
      result,
    }),
  );
}

async function backup(options: RunOptions, runDir: string): Promise<void> {
  if (options.backup === undefined) {
    return;
  }
  const findings = await scanForKeys(runDir);
  if (findings.length > 0) {
    const list = findings.map((finding) => `${finding.file} (${finding.kind})`).join(", ");
    throw new RunError(`backup blocked: the run folder holds what looks like a key: ${list}`);
  }
  await options.backup(runDir);
}

/** Runs a council: the blind round, then discussion rounds in `discuss` mode, with a record of every turn. */
export async function runCouncil(options: RunOptions): Promise<RunOutcome> {
  const items = options.items ?? [ANSWER_ITEM];
  const runId = options.runId ?? newRunId();
  const store = new RunStore(join(options.outDir, runId));
  const labels = options.council.members.map((_, index) => memberLabel(index));
  const inputs = await inputHashes(options, items);
  await mkdir(store.dir, { recursive: true });
  await checkResume(store, inputs);
  await store.init(labels);
  const prepared = await prepareMembers(options, store, items, labels);
  const writeMeta = (): Promise<void> =>
    store.writeJson("run.json", { ...runMeta(options, runId, labels, prepared.plans, prepared.members), inputs });
  await writeMeta();
  const council = options.council.council;
  const state = startCouncil({ mode: council.mode, rule: council.rule, rounds: council.rounds, items, labels });
  const loop: Loop = {
    options,
    store,
    members: prepared.members,
    state,
    saved: await loadSaved(store, labels),
    records: [],
    startedAt: Date.now(),
  };
  let outcome: { stop: StopReason; result: CouncilResult };
  try {
    const stop = await playRounds(loop);
    outcome = { stop, result: councilResult(state) };
    await writeMeta();
    await finish(options, store, runId, outcome, labels);
  } finally {
    await Promise.all(prepared.members.map((member) => member.close()));
    await store.close();
    await rm(prepared.scratch, { recursive: true, force: true });
  }
  await backup(options, store.dir);
  return { runId, runDir: store.dir, ...outcome };
}
