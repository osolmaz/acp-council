import type { Message, Mode } from "./types.ts";

export type Viewer = {
  label: string;
  round: number;
  /** A new session does not remember the member's own earlier messages. */
  freshSession: boolean;
};

/** The rules of a mode: how many rounds it plays, who sees which message, and what each round asks for. */
export type ModeRules = {
  name: Mode;
  /** The last round that the mode plays, given the jury's limit of discussion rounds. */
  lastRound: (discussionRounds: number) => number;
  visible: (message: Message, viewer: Viewer) => boolean;
  instruction: (round: number, openItems: string[]) => string;
};

function itemList(openItems: string[]): string {
  return openItems.map((id) => `\`${id}\``).join(", ");
}

function voteExample(openItems: string[]): string {
  const example = Object.fromEntries(openItems.map((id) => [id, { choice: "...", reason: "..." }]));
  return `\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``;
}

function blindRound(openItems: string[]): string {
  return [
    "## Round 1",
    `This round is blind: you do not see the other members' answers. Vote on every item: ${itemList(openItems)}.`,
    `End your reply with the vote block, for example:\n\n${voteExample(openItems)}`,
  ].join("\n\n");
}

function discussionRound(round: number, openItems: string[]): string {
  return [
    `## Round ${round}`,
    `These items are still open: ${itemList(openItems)}. Read the other members' messages. Reply to their arguments, then vote again on each open item. You can keep your vote or change it. If you change a vote, say why in its reason.`,
    `End your reply with the vote block for the open items only, for example:\n\n${voteExample(openItems)}`,
  ].join("\n\n");
}

/** One blind round. No member sees another member's message. */
export const blind: ModeRules = {
  name: "blind",
  lastRound: () => 1,
  visible: () => false,
  instruction: (_round, openItems) => blindRound(openItems),
};

/** A blind round, then rounds in which every member sees every message from the rounds that have ended. */
export const discuss: ModeRules = {
  name: "discuss",
  lastRound: (discussionRounds) => 1 + discussionRounds,
  visible: (message, viewer) => message.round < viewer.round && (viewer.freshSession || message.from !== viewer.label),
  instruction: (round, openItems) => (round === 1 ? blindRound(openItems) : discussionRound(round, openItems)),
};

export const MODES: Record<Mode, ModeRules> = { blind, discuss };
