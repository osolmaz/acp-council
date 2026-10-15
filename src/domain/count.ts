import type { ItemOutcome, Rule, Vote } from "./types.ts";

/**
 * Counts the choices for one item. A missing vote is never part of an agreement,
 * so an item with a missing vote can only close under `majority`.
 */
export function countItem(choices: (string | undefined)[], rule: Rule): ItemOutcome {
  const tally = new Map<string, number>();
  for (const choice of choices) {
    if (choice !== undefined) {
      tally.set(choice, (tally.get(choice) ?? 0) + 1);
    }
  }
  const needed = rule === "unanimous" ? choices.length : Math.floor(choices.length / 2) + 1;
  for (const [choice, count] of tally) {
    if (count >= needed) {
      return { status: "agreed", choice };
    }
  }
  return { status: "split" };
}

/** Counts every item for one round. `votes` holds one entry per member; `undefined` is a member with no result. */
export function countRound(itemIds: string[], votes: (Vote | undefined)[], rule: Rule): Map<string, ItemOutcome> {
  const outcomes = new Map<string, ItemOutcome>();
  for (const id of itemIds) {
    outcomes.set(
      id,
      countItem(
        votes.map((vote) => vote?.[id]?.choice),
        rule,
      ),
    );
  }
  return outcomes;
}
