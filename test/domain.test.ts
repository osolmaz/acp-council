import { describe, expect, it } from "vitest";
import { memberLabel, messageId, visibleMessages } from "../src/domain/board.ts";
import { countItem, countRound } from "../src/domain/count.ts";
import { applyRound, councilResult, nextRound, startCouncil, type CouncilSpec } from "../src/domain/council.ts";
import { buildNudgePrompt, buildTurnPrompt, formatMessage } from "../src/domain/prompts.ts";
import { renderReport } from "../src/domain/report.ts";
import type { Message, Vote } from "../src/domain/types.ts";
import { checkVote, compileVoteSchema, extractJsonBlock } from "../src/domain/vote.ts";

function v(entries: Record<string, string>): Vote {
  return Object.fromEntries(Object.entries(entries).map(([id, choice]) => [id, { choice, reason: `why ${choice}` }]));
}

describe("countItem", () => {
  it("agrees when every member chose the same under unanimous", () => {
    expect(countItem(["yes", "yes", "yes"], "unanimous")).toEqual({ status: "agreed", choice: "yes" });
  });

  it("splits on any difference or missing vote under unanimous", () => {
    expect(countItem(["yes", "no"], "unanimous")).toEqual({ status: "split" });
    expect(countItem(["yes", undefined], "unanimous")).toEqual({ status: "split" });
  });

  it("needs more than half of all members under majority", () => {
    expect(countItem(["yes", "yes", "no"], "majority")).toEqual({ status: "agreed", choice: "yes" });
    expect(countItem(["yes", "no"], "majority")).toEqual({ status: "split" });
    expect(countItem(["yes", undefined, undefined], "majority")).toEqual({ status: "split" });
    expect(countItem(["yes", "yes", undefined], "majority")).toEqual({ status: "agreed", choice: "yes" });
  });

  it("counts each item of a round", () => {
    const outcomes = countRound(["a", "b"], [v({ a: "x", b: "y" }), v({ a: "x", b: "z" }), undefined], "majority");
    expect(outcomes.get("a")).toEqual({ status: "agreed", choice: "x" });
    expect(outcomes.get("b")).toEqual({ status: "split" });
  });
});

describe("board", () => {
  it("labels members A to Z and then AA", () => {
    expect([0, 1, 25, 26, 27, 52].map(memberLabel)).toEqual([
      "member:A",
      "member:B",
      "member:Z",
      "member:AA",
      "member:AB",
      "member:BA",
    ]);
  });

  it("numbers messages", () => {
    expect(messageId(0)).toBe("m0001");
    expect(messageId(41)).toBe("m0042");
  });

  it("shows messages from ended rounds, and own messages only to a new session", () => {
    const message = (id: string, round: number, from: string): Message => ({
      id,
      round,
      from,
      refs: [],
      body: id,
      vote: {},
      createdAt: "",
    });
    const board = [message("m1", 1, "member:A"), message("m2", 1, "member:B"), message("m3", 2, "member:B")];
    expect(visibleMessages(board, "member:A", 2, false).map((m) => m.id)).toEqual(["m2"]);
    expect(visibleMessages(board, "member:A", 2, true).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(visibleMessages(board, "member:A", 3, false).map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(visibleMessages(board, "member:A", 1, true)).toEqual([]);
  });
});

describe("votes", () => {
  const schema = compileVoteSchema({
    type: "object",
    properties: {
      choice: { type: "string", enum: ["yes", "no"] },
      reason: { type: "string" },
      fix: { type: "string" },
    },
    required: ["choice", "reason"],
  });

  it("reads the choices from the schema", () => {
    expect(schema.choices).toEqual(["yes", "no"]);
    expect(compileVoteSchema().choices).toBeNull();
  });

  it("takes the last fenced block and keeps the rest as the body", () => {
    const text = 'Intro.\n\n```json\n{"a": 1}\n```\n\nMore.\n\n```json\n{"b": 2}\n```\n';
    expect(extractJsonBlock(text)).toEqual({
      ok: true,
      body: 'Intro.\n\n```json\n{"a": 1}\n```\n\nMore.',
      json: { b: 2 },
    });
  });

  it("reports a reply without a block or with invalid JSON", () => {
    expect(extractJsonBlock("no block")).toEqual({ ok: false, error: "the reply has no fenced JSON block" });
    const invalid = extractJsonBlock("```json\n{nope}\n```");
    expect(invalid.ok).toBe(false);
  });

  it("accepts a vote for every open item and keeps extra fields", () => {
    const text =
      'Body.\n```json\n{"a": {"choice": "yes", "reason": "r"}, "b": {"choice": "no", "reason": "s", "fix": "f"}}\n```';
    expect(checkVote(text, ["a", "b"], schema)).toEqual({
      ok: true,
      body: "Body.",
      vote: { a: { choice: "yes", reason: "r" }, b: { choice: "no", reason: "s", fields: { fix: "f" } } },
    });
  });

  it("rejects missing and invalid items, and ignores items that are not open", () => {
    const text = '```json\n{"a": {"choice": "maybe", "reason": "r"}, "c": {"choice": "yes", "reason": "r"}}\n```';
    const check = checkVote(text, ["a", "b"], schema);
    expect(check.ok).toBe(false);
    const errors = check.ok ? [] : check.errors;
    expect(errors.some((e) => e.startsWith("c"))).toBe(false);
    expect(errors.some((e) => e.startsWith("a.choice"))).toBe(true);
    expect(errors).toContain("b: the block has no vote for this item");
    const closed = checkVote(
      '```json\n{"a": {"choice": "yes", "reason": "r"}, "c": {"choice": "yes", "reason": "r"}}\n```',
      ["a"],
      schema,
    );
    expect(closed).toEqual({ ok: true, body: "", vote: { a: { choice: "yes", reason: "r" } } });
  });

  it("rejects a block that is not an object, and a vote without a reason", () => {
    expect(checkVote("```json\n[1]\n```", ["a"], schema).ok).toBe(false);
    expect(checkVote("no block", ["a"], schema).ok).toBe(false);
    const check = checkVote('```json\n{"a": {"choice": "yes"}}\n```', ["a"], compileVoteSchema());
    expect(check.ok ? [] : check.errors).toContain("a.reason: Invalid input: expected string, received undefined");
  });
});

describe("council rounds", () => {
  const spec = (mode: CouncilSpec["mode"]): CouncilSpec => ({
    mode,
    rule: "unanimous",
    rounds: 5,
    items: [
      { id: "a", text: "" },
      { id: "b", text: "" },
    ],
    labels: ["member:A", "member:B"],
  });

  it("plays one round in blind mode", () => {
    const state = startCouncil(spec("blind"));
    expect(nextRound(state)).toEqual({ round: 1, openItems: ["a", "b"] });
    applyRound(
      state,
      1,
      new Map([
        ["member:A", v({ a: "yes", b: "yes" })],
        ["member:B", v({ a: "yes", b: "no" })],
      ]),
    );
    expect(nextRound(state)).toBeNull();
    const result = councilResult(state);
    expect(result).toMatchObject({ mode: "blind", rounds: 1, agreed: 1, split: 1 });
    expect(result.items[0]).toMatchObject({ id: "a", status: "agreed", choice: "yes", closedInRound: 1 });
    expect(result.items[1]).toMatchObject({ id: "b", status: "split", choice: null, closedInRound: null });
  });

  it("discusses only open items, records changes, and ends when all agree", () => {
    const state = startCouncil(spec("discuss"));
    applyRound(
      state,
      1,
      new Map([
        ["member:A", v({ a: "yes", b: "yes" })],
        ["member:B", v({ a: "yes", b: "no" })],
      ]),
    );
    expect(nextRound(state)).toEqual({ round: 2, openItems: ["b"] });
    applyRound(
      state,
      2,
      new Map([
        ["member:A", v({ b: "yes" })],
        ["member:B", v({ b: "yes" })],
      ]),
    );
    expect(nextRound(state)).toBeNull();
    const b = councilResult(state).items[1];
    expect(b).toMatchObject({ status: "agreed", choice: "yes", closedInRound: 2 });
    expect(b?.members["member:B"]).toEqual({
      blind: { choice: "no", reason: "why no" },
      final: { choice: "yes", reason: "why yes" },
      changes: [{ round: 2, from: "no", to: "yes", reason: "why yes" }],
    });
  });

  it("stops at the round limit and counts a missing vote as no agreement", () => {
    const state = startCouncil(spec("discuss"));
    for (let next = nextRound(state); next !== null; next = nextRound(state)) {
      applyRound(
        state,
        next.round,
        new Map([
          ["member:A", v({ a: "yes", b: "yes" })],
          ["member:B", undefined],
        ]),
      );
    }
    const result = councilResult(state);
    expect(result.rounds).toBe(6);
    expect(result.split).toBe(2);
    expect(result.items[0]?.members["member:B"]).toEqual({ blind: null, final: null, changes: [] });
  });
});

describe("prompts", () => {
  const schema = compileVoteSchema({
    type: "object",
    properties: { choice: { enum: ["yes", "no"] }, reason: { type: "string" } },
  });
  const intro = {
    label: "member:A",
    memberCount: 2,
    question: "Is it good?",
    items: [
      { id: "a", text: "first" },
      { id: "b", text: "" },
    ],
    schema,
  };
  const message: Message = {
    id: "m0001",
    round: 1,
    from: "member:B",
    refs: [],
    body: "I think so.",
    vote: v({ a: "yes" }),
    createdAt: "",
  };

  it("gives a new session the question, the items and the vote format", () => {
    const text = buildTurnPrompt({ intro, messages: [], round: 1, openItems: ["a", "b"], label: "member:A" });
    expect(text).toContain("You are member:A, one of 2 members");
    expect(text).toContain("Is it good?");
    expect(text).toContain("- `a`: first\n- `b`");
    expect(text).toContain("Allowed choices: `yes`, `no`.");
    expect(text).toContain("## Round 1\n\nThis round is blind");
    expect(text).not.toContain("## Messages");
  });

  it("gives a later round the new messages and the open items", () => {
    const text = buildTurnPrompt({ messages: [message], round: 2, openItems: ["a"], label: "member:A" });
    expect(text).not.toContain("## Question");
    expect(text).toContain("### member:B, round 1\n\nI think so.\n\nVotes:\n- `a`: yes. why yes");
    expect(text).toContain("## Round 2\n\nThese items are still open: `a`.");
  });

  it("marks a member's own message", () => {
    expect(formatMessage({ ...message, vote: {} }, "member:B")).toBe("### member:B (you), round 1\n\nI think so.");
  });

  it("nudges with the errors", () => {
    expect(buildNudgePrompt(["a: bad"], ["a"])).toContain("- a: bad");
  });
});

describe("report", () => {
  it("lists split items first and escapes table cells", () => {
    const state = startCouncil({
      mode: "discuss",
      rule: "unanimous",
      rounds: 5,
      items: [
        { id: "a", text: "" },
        { id: "b", text: "" },
      ],
      labels: ["member:A", "member:B"],
    });
    applyRound(
      state,
      1,
      new Map([
        ["member:A", { a: { choice: "yes", reason: "x | y" }, b: { choice: "no", reason: "n" } }],
        ["member:B", { a: { choice: "yes", reason: "z" }, b: { choice: "yes", reason: "m" } }],
      ]),
    );
    applyRound(state, 2, new Map([["member:A", { b: { choice: "yes", reason: "agreed now" } }]]));
    const report = renderReport({
      runId: "r1",
      council: "review",
      maxRounds: 5,
      members: [
        { label: "member:A", name: "one", agent: "claude", model: "opus" },
        { label: "member:B", name: "two", agent: "codex", model: "astra" },
      ],
      result: councilResult(state),
    });
    expect(report).toContain("- Rounds: 2 of at most 6");
    expect(report).toContain("### b: split");
    expect(report).toContain("| member:B | yes | yes | m |");
    expect(report).toContain("- member:A changed from no to yes in round 2: agreed now");
    expect(report).toContain("### a: agreed on yes in round 1");
    expect(report).toContain("x \\| y");
    expect(report.indexOf("## Split items")).toBeLessThan(report.indexOf("## Agreed items"));
  });

  it("says none for empty sections", () => {
    const state = startCouncil({
      mode: "blind",
      rule: "majority",
      rounds: 5,
      items: [{ id: "a", text: "" }],
      labels: ["member:A"],
    });
    applyRound(state, 1, new Map([["member:A", v({ a: "yes" })]]));
    const report = renderReport({ runId: "r", council: "c", maxRounds: 5, members: [], result: councilResult(state) });
    expect(report).toContain("## Split items\n\nNone.");
    expect(report).toContain("- Rounds: 1\n");
  });
});
