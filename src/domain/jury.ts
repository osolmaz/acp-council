import { countRound } from "./count.ts";
import { MODES } from "./modes.ts";
import type { JuryResult, Item, ItemResult, ItemVote, MemberItemRecord, Mode, Rule, Vote } from "./types.ts";

export type JurySpec = {
  mode: Mode;
  rule: Rule;
  /** The most discussion rounds after the blind round. Not used in `blind` mode. */
  rounds: number;
  items: Item[];
  labels: string[];
};

type CastVote = { round: number; vote: ItemVote };

/** The state of the rounds: which items are open, and every valid vote of every member. */
export type JuryState = {
  spec: JurySpec;
  /** The last round that ended; 0 before the blind round. */
  round: number;
  open: string[];
  closed: Map<string, { choice: string; round: number }>;
  history: Map<string, Map<string, CastVote[]>>;
};

export type NextRound = { round: number; openItems: string[] };

export function startJury(spec: JurySpec): JuryState {
  return {
    spec,
    round: 0,
    open: spec.items.map((item) => item.id),
    closed: new Map(),
    history: new Map(spec.labels.map((label) => [label, new Map<string, CastVote[]>()])),
  };
}

export function nextRound(state: JuryState): NextRound | null {
  if (state.open.length === 0 || state.round >= MODES[state.spec.mode].lastRound(state.spec.rounds)) {
    return null;
  }
  return { round: state.round + 1, openItems: [...state.open] };
}

function record(state: JuryState, label: string, round: number, vote: Vote | undefined): void {
  const memberHistory = state.history.get(label);
  if (memberHistory === undefined || vote === undefined) {
    return;
  }
  for (const id of state.open) {
    const itemVote = vote[id];
    if (itemVote !== undefined) {
      memberHistory.set(id, [...(memberHistory.get(id) ?? []), { round, vote: itemVote }]);
    }
  }
}

/** Records one round's votes and closes the items whose votes meet the rule. `votes` maps a label to its vote, or to nothing. */
export function applyRound(state: JuryState, round: number, votes: Map<string, Vote | undefined>): void {
  for (const label of state.spec.labels) {
    record(state, label, round, votes.get(label));
  }
  const outcomes = countRound(
    state.open,
    state.spec.labels.map((label) => votes.get(label)),
    state.spec.rule,
  );
  for (const [id, outcome] of outcomes) {
    if (outcome.status === "agreed") {
      state.closed.set(id, { choice: outcome.choice, round });
    }
  }
  state.open = state.open.filter((id) => !state.closed.has(id));
  state.round = round;
}

function memberRecord(cast: CastVote[]): MemberItemRecord {
  const changes = cast.slice(1).flatMap((current, index) => {
    const previous = cast[index];
    return previous === undefined || previous.vote.choice === current.vote.choice
      ? []
      : [{ round: current.round, from: previous.vote.choice, to: current.vote.choice, reason: current.vote.reason }];
  });
  const blind = cast.find((entry) => entry.round === 1);
  return { blind: blind?.vote ?? null, final: cast.at(-1)?.vote ?? null, changes };
}

function itemResult(state: JuryState, id: string): ItemResult {
  const closed = state.closed.get(id);
  const members = Object.fromEntries(
    state.spec.labels.map((label) => [label, memberRecord(state.history.get(label)?.get(id) ?? [])]),
  );
  return closed === undefined
    ? { id, status: "split", choice: null, closedInRound: null, members }
    : { id, status: "agreed", choice: closed.choice, closedInRound: closed.round, members };
}

export function juryResult(state: JuryState): JuryResult {
  const items = state.spec.items.map((item) => itemResult(state, item.id));
  return {
    mode: state.spec.mode,
    rule: state.spec.rule,
    rounds: state.round,
    agreed: items.filter((item) => item.status === "agreed").length,
    split: items.filter((item) => item.status === "split").length,
    items,
  };
}
