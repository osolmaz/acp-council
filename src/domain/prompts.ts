import type { Item, Message, Vote } from "./types.ts";
import type { VoteSchema } from "./vote.ts";

export type Intro = {
  label: string;
  memberCount: number;
  question: string;
  items: Item[];
  schema: VoteSchema;
};

export type TurnPrompt = {
  /** Present on the first turn of a session: the question, the items and how to vote. */
  intro?: Intro;
  /** Messages the member may see that are new to this session. */
  messages: Message[];
  round: number;
  openItems: string[];
  /** The member's own label, so that its own earlier messages are marked as its own. */
  label: string;
};

function formatItems(items: Item[]): string {
  return items.map((item) => (item.text === "" ? `- \`${item.id}\`` : `- \`${item.id}\`: ${item.text}`)).join("\n");
}

function formatChoices(schema: VoteSchema): string {
  const choices =
    schema.choices === null ? "" : `Allowed choices: ${schema.choices.map((c) => `\`${c}\``).join(", ")}.\n\n`;
  return `${choices}Each item's vote must match this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(schema.jsonSchema, null, 2)}\n\`\`\``;
}

function voteExample(openItems: string[]): string {
  const example = Object.fromEntries(openItems.map((id) => [id, { choice: "...", reason: "..." }]));
  return `\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``;
}

export function formatIntro(intro: Intro): string {
  return [
    `You are ${intro.label}, one of ${intro.memberCount} members of a council. Each member is an AI agent that answers the same question on its own. The other members see you only by your label.`,
    "Your working folder holds the material for the question. Read it with your tools. Do not change any file.",
    `## Question\n\n${intro.question.trim()}`,
    `## Items\n\nVote on each of these items:\n\n${formatItems(intro.items)}`,
    `## How to vote\n\nEnd every reply with one fenced JSON block that maps each open item ID to your vote. ${formatChoices(intro.schema)}`,
  ].join("\n\n");
}

function formatVote(vote: Vote): string {
  return Object.entries(vote)
    .map(([id, itemVote]) => `- \`${id}\`: ${itemVote.choice}. ${itemVote.reason}`)
    .join("\n");
}

export function formatMessage(message: Message, label: string): string {
  const author = message.from === label ? `${message.from} (you)` : message.from;
  const votes = Object.keys(message.vote).length === 0 ? "" : `\n\nVotes:\n${formatVote(message.vote)}`;
  return `### ${author}, round ${message.round}\n\n${message.body.trim()}${votes}`;
}

function instruction(round: number, openItems: string[]): string {
  const ids = openItems.map((id) => `\`${id}\``).join(", ");
  if (round === 1) {
    return `## Round 1\n\nThis round is blind: you do not see the other members' answers. Vote on every item: ${ids}.\n\nEnd your reply with the vote block, for example:\n\n${voteExample(openItems)}`;
  }
  return [
    `## Round ${round}`,
    `These items are still open: ${ids}. Read the other members' messages. Reply to their arguments, then vote again on each open item. You can keep your vote or change it. If you change a vote, say why in its reason.`,
    `End your reply with the vote block for the open items only, for example:\n\n${voteExample(openItems)}`,
  ].join("\n\n");
}

export function buildTurnPrompt(prompt: TurnPrompt): string {
  const parts: string[] = [];
  if (prompt.intro !== undefined) {
    parts.push(formatIntro(prompt.intro));
  }
  if (prompt.messages.length > 0) {
    parts.push(`## Messages\n\n${prompt.messages.map((m) => formatMessage(m, prompt.label)).join("\n\n")}`);
  }
  parts.push(instruction(prompt.round, prompt.openItems));
  return parts.join("\n\n");
}

export function buildNudgePrompt(errors: string[], openItems: string[]): string {
  const list = errors.map((error) => `- ${error}`).join("\n");
  return `Your vote block could not be used:\n\n${list}\n\nReply again. End the reply with one corrected fenced JSON block for these items: ${openItems.map((id) => `\`${id}\``).join(", ")}.`;
}
