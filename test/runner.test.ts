import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedCouncil } from "../src/config/load.ts";
import { councilFileSchema, type CouncilFile } from "../src/config/schema.ts";
import { boardFromRecords } from "../src/run/board.ts";
import { RunError } from "../src/run/errors.ts";
import { newRunId } from "../src/run/inputs.ts";
import type { Progress } from "../src/run/rounds.ts";
import { runCouncil, type RunOptions } from "../src/run/runner.ts";
import { fakeMember, folderWith, prompts, reply, tempDir, type FakeScript } from "./helpers.ts";

type Setup = { dir: string; folder: string; logs: string[]; council: ResolvedCouncil };

async function setup(
  scripts: FakeScript[],
  council: Partial<CouncilFile> = {},
  schema?: Record<string, unknown>,
): Promise<Setup> {
  const dir = await tempDir();
  const folder = await folderWith(dir, { "doc.txt": "The document." });
  const members = await Promise.all(scripts.map((script, index) => fakeMember(dir, `m${index}`, script)));
  const names = members.map((_, index) => `fake${index}`);
  return {
    dir,
    folder,
    logs: members.map((member) => member.log),
    council: {
      name: "test",
      level: "file",
      path: join(dir, "test.json"),
      settings: councilFileSchema.parse({ members: names, ...council }),
      membersPath: join(dir, "members.json"),
      members: members.map((member, index) => ({ name: names[index] ?? "", config: member.config })),
      schema: schema === undefined ? null : { path: join(dir, "schema.json"), json: schema },
      question: null,
    },
  };
}

const items = [
  { id: "a", text: "first" },
  { id: "b", text: "second" },
];

function options(s: Setup, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    council: s.council,
    folder: s.folder,
    question: "Check the document.",
    items,
    outDir: join(s.dir, "runs"),
    ...extra,
  };
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("runCouncil", () => {
  it("runs a blind panel and writes the run folder", async () => {
    const s = await setup([
      { rounds: { "1": { reply: reply("A thinks.", { a: ["yes", "ra"], b: ["yes", "rb"] }) } } },
      { rounds: { "1": { reply: reply("B thinks.", { a: ["yes", "sa"], b: ["no", "sb"] }) } } },
      { rounds: { "1": { reply: reply("C thinks.", { a: ["yes", "ta"], b: ["no", "tb"] }) } } },
    ]);
    const progress: Progress[] = [];
    const outcome = await runCouncil(options(s, { runId: "blind-1", onProgress: (p) => progress.push(p) }));
    expect(outcome).toMatchObject({ runId: "blind-1", stop: "rounds_done" });
    expect(outcome.result).toMatchObject({ mode: "blind", rounds: 1, agreed: 1, split: 1 });
    expect(progress.filter((p) => p.type === "turn")).toHaveLength(3);
    const files = await readdir(outcome.runDir);
    expect(files.sort()).toEqual(["board.jsonl", "members", "report.md", "result.json", "run.json"]);
    const run = await json(join(outcome.runDir, "run.json"));
    expect(run).toMatchObject({ runId: "blind-1", acpCouncilVersion: "0.1.0", question: "Check the document." });
    expect(run).toMatchObject({
      members: [
        { label: "member:A", name: "fake0", clean: null, session: { agentName: "fake-agent" } },
        { label: "member:B" },
        { label: "member:C" },
      ],
    });
    expect(await json(join(outcome.runDir, "result.json"))).toMatchObject({ stop: "rounds_done", agreed: 1 });
    const board = (await readFile(join(outcome.runDir, "board.jsonl"), "utf8")).trim().split("\n");
    expect(board.map((line) => (JSON.parse(line) as { from: string; body: string }).body)).toEqual([
      "A thinks.",
      "B thinks.",
      "C thinks.",
    ]);
    expect(await readFile(join(outcome.runDir, "report.md"), "utf8")).toContain("### b: split");
    expect(await readdir(join(outcome.runDir, "members", "A"))).toEqual(
      expect.arrayContaining(["events.ndjson", "stderr.log", "turns"]),
    );
    const firstPrompt = (await prompts(s.logs[1] ?? ""))[0] ?? "";
    expect(firstPrompt).toContain("You are member:B, one of 3 members");
    expect(firstPrompt).not.toContain("A thinks.");
  });

  it("discusses the split items until the members agree", async () => {
    const s = await setup(
      [
        {
          rounds: {
            "1": { reply: reply("Item b is fine.", { a: ["yes", "ra"], b: ["yes", "b is fine"] }) },
            "*": { reply: reply("Still fine.", { b: ["yes", "still fine"] }) },
          },
        },
        {
          rounds: {
            "1": { reply: reply("Item b is wrong.", { a: ["yes", "sa"], b: ["no", "b is wrong"] }) },
            "2": { reply: reply("A convinced me.", { b: ["yes", "A is right"] }) },
          },
        },
      ],
      { mode: "discuss" },
    );
    const outcome = await runCouncil(options(s));
    expect(outcome.stop).toBe("all_agreed");
    expect(outcome.result).toMatchObject({ rounds: 2, agreed: 2, split: 0 });
    expect(outcome.result.items[1]?.members["member:B"]?.changes).toEqual([
      { round: 2, from: "no", to: "yes", reason: "A is right" },
    ]);
    const [, second] = await prompts(s.logs[1] ?? "");
    expect(second).toContain("### member:A, round 1\n\nItem b is fine.");
    expect(second).not.toContain("### member:B");
    expect(second).toContain("These items are still open: `b`.");
    expect(second).not.toContain("## Question");
  });

  it("stops at the round limit when the members never agree", async () => {
    const s = await setup(
      [
        { rounds: { "*": { reply: reply("yes", { a: ["yes", "r"], b: ["yes", "r"] }) } } },
        {
          rounds: {
            "1": { reply: reply("no", { a: ["yes", "r"], b: ["no", "r"] }) },
            "*": { reply: reply("no", { b: ["no", "r"] }) },
          },
        },
      ],
      { mode: "discuss", rounds: 5 },
    );
    const outcome = await runCouncil(options(s));
    expect(outcome.stop).toBe("rounds_done");
    expect(outcome.result).toMatchObject({ rounds: 6, agreed: 1, split: 1 });
    expect(await prompts(s.logs[0] ?? "")).toHaveLength(6);
    expect(outcome.result.items[1]?.members["member:A"]?.final).toEqual({ choice: "yes", reason: "r" });
  });

  it("nudges once on an invalid vote, then gives up", async () => {
    const s = await setup(
      [
        { rounds: { "1": { reply: "I forgot the block." } }, nudge: { reply: reply("", { answer: ["yes", "r"] }) } },
        { rounds: { "1": { reply: "No block." } }, nudge: { reply: "Still none." } },
      ],
      {},
      { type: "object", properties: { choice: { enum: ["yes", "no"] }, reason: { type: "string" } } },
    );
    const outcome = await runCouncil({ ...options(s), items: undefined });
    const answer = outcome.result.items[0];
    expect(answer?.id).toBe("answer");
    expect(answer?.members["member:A"]?.final).toEqual({ choice: "yes", reason: "r" });
    expect(answer?.members["member:B"]?.final).toBeNull();
    expect(answer?.status).toBe("split");
    const record = await json(join(outcome.runDir, "members", "B", "turns", "1.json"));
    expect(record).toMatchObject({ status: "no_result", body: "No block." });
    expect(record["attempts"]).toHaveLength(2);
    expect((await prompts(s.logs[0] ?? ""))[1]).toContain("Your vote block could not be used");
  });

  it("resumes a stopped run without repeating saved turns", async () => {
    const scripts: FakeScript[] = [
      {
        rounds: {
          "1": { reply: reply("A1", { a: ["yes", "r"], b: ["yes", "r"] }) },
          "*": { reply: reply("A2", { b: ["yes", "r"] }) },
        },
      },
      {
        rounds: {
          "1": { reply: reply("B1", { a: ["yes", "r"], b: ["no", "r"] }) },
          "*": { reply: reply("B2", { b: ["yes", "r"] }) },
        },
      },
    ];
    const s = await setup(scripts, { mode: "discuss" });
    const first = await runCouncil(options(s, { runId: "resume" }));
    expect(first.result.rounds).toBe(2);
    for (const label of ["A", "B"]) {
      await rm(join(first.runDir, "members", label, "turns", "2.json"));
    }
    await rm(s.logs[0] ?? "");
    const second = await runCouncil(options(s, { runId: "resume" }));
    expect(second.result).toEqual(first.result);
    const resumed = await prompts(s.logs[0] ?? "");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain("You are member:A");
    expect(resumed[0]).toContain("### member:A (you), round 1\n\nA1");
    expect(resumed[0]).toContain("### member:B, round 1\n\nB1");
    expect(resumed[0]).toContain("## Round 2");
  });

  it("refuses to resume a run with other inputs", async () => {
    const s = await setup([{ rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["y", "r"] }) } } }]);
    await runCouncil(options(s, { runId: "same" }));
    await expect(runCouncil(options(s, { runId: "same", question: "Another question." }))).rejects.toThrow(RunError);
  });

  it("stops at the time limit and the token limit", async () => {
    const slow = await setup(
      [
        { rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["y", "r"] }), delayMs: 1100 } } },
        { rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["n", "r"] }) } } },
      ],
      { mode: "discuss", limits: { maxRunSec: 1 } },
    );
    expect((await runCouncil(options(slow))).stop).toBe("time_limit");
    const costly = await setup(
      [
        { rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["y", "r"] }), totalTokens: 100 } } },
        { rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["n", "r"] }) } } },
      ],
      { mode: "discuss", limits: { maxTokens: 50 } },
    );
    const outcome = await runCouncil(options(costly));
    expect(outcome).toMatchObject({ stop: "token_limit", result: { rounds: 1, split: 1 } });
  });

  it("records a member that cannot start, and keeps going", async () => {
    const s = await setup(
      [{ failSessionNew: true }, { rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["y", "r"] }) } } }],
      { concurrency: 1 },
    );
    const outcome = await runCouncil(options(s));
    expect(outcome.result.split).toBe(2);
    const record = await json(join(outcome.runDir, "members", "A", "turns", "1.json"));
    expect(record).toMatchObject({ status: "no_result" });
    expect(JSON.stringify(record["attempts"])).toContain("could not start");
  });

  it("backs up only a run folder with no key in it", async () => {
    const s = await setup([{ rounds: { "*": { reply: reply("x", { a: ["y", "r"], b: ["y", "r"] }) } } }]);
    const backedUp: string[] = [];
    const outcome = await runCouncil(options(s, { backup: (dir) => Promise.resolve(void backedUp.push(dir)) }));
    expect(backedUp).toEqual([outcome.runDir]);
    const leaky = runCouncil(
      options(s, {
        question: `Use ${"hf_" + "b".repeat(34)}`,
        backup: () => Promise.reject(new Error("must not run")),
      }),
    );
    await expect(leaky).rejects.toThrow("backup blocked");
  });
});

describe("run helpers", () => {
  it("makes sortable run IDs", () => {
    expect(newRunId(new Date("2026-10-16T01:02:03.456Z"))).toMatch(/^20261016T010203Z-[0-9a-f]{6}$/);
  });

  it("builds the board only from ended rounds, in label order", () => {
    const record = (label: string, round: number, body: string) => ({
      round,
      label,
      status: "voted" as const,
      body,
      vote: null,
      attempts: [],
      endedAt: "t",
    });
    const board = boardFromRecords(
      [
        record("member:B", 1, "b1"),
        record("member:A", 1, "a1"),
        record("member:A", 2, "a2"),
        record("member:C", 1, ""),
      ],
      1,
    );
    expect(board.map((m) => [m.id, m.from, m.body])).toEqual([
      ["m0001", "member:A", "a1"],
      ["m0002", "member:B", "b1"],
    ]);
  });
});
