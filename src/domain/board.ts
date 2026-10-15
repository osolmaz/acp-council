import type { Message } from "./types.ts";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Anonymous labels: member:A to member:Z, then member:AA and on. */
export function memberLabel(index: number): string {
  let name = "";
  let rest = index;
  do {
    name = (LETTERS[rest % LETTERS.length] ?? "") + name;
    rest = Math.floor(rest / LETTERS.length) - 1;
  } while (rest >= 0);
  return `member:${name}`;
}

export function messageId(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}

/**
 * The messages that a member may see at the start of a round: every message from a round that has ended.
 * A member's own messages are shown only to a new session, which does not remember them.
 */
export function visibleMessages(messages: Message[], label: string, round: number, includeOwn: boolean): Message[] {
  return messages.filter((message) => message.round < round && (includeOwn || message.from !== label));
}
