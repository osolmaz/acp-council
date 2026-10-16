export type Mode = "blind" | "discuss";

export type Rule = "unanimous" | "majority";

export type Item = {
  id: string;
  text: string;
};

export type ItemVote = {
  choice: string;
  reason: string;
  /** Extra fields that the run's vote schema allows, such as a proposed fix. */
  fields?: Record<string, unknown>;
};

/** One vote per item ID. */
export type Vote = Record<string, ItemVote>;

/** A post on the board. `from` is a member label such as `member:A`, or `runtime`. */
export type Message = {
  id: string;
  round: number;
  from: string;
  refs: string[];
  body: string;
  vote: Vote;
  createdAt: string;
};

export type ItemOutcome = { status: "agreed"; choice: string } | { status: "split" };

export type VoteChange = {
  round: number;
  from: string;
  to: string;
  reason: string;
};

export type MemberItemRecord = {
  blind: ItemVote | null;
  final: ItemVote | null;
  changes: VoteChange[];
};

export type ItemResult = {
  id: string;
  status: "agreed" | "split";
  choice: string | null;
  closedInRound: number | null;
  members: Record<string, MemberItemRecord>;
};

export type JuryResult = {
  mode: Mode;
  rule: Rule;
  rounds: number;
  agreed: number;
  split: number;
  items: ItemResult[];
};
