import type { CouncilResult, ItemResult, ItemVote } from "./types.ts";

export type ReportMember = {
  label: string;
  name: string;
  agent: string;
  model: string;
};

export type ReportInput = {
  runId: string;
  council: string;
  maxRounds: number;
  members: ReportMember[];
  result: CouncilResult;
};

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function choiceOf(vote: ItemVote | null): string {
  return vote === null ? "no vote" : vote.choice;
}

function memberTable(item: ItemResult): string {
  const rows = Object.entries(item.members).map(
    ([label, record]) =>
      `| ${label} | ${choiceOf(record.blind)} | ${choiceOf(record.final)} | ${cell(record.final?.reason ?? "")} |`,
  );
  return ["| Member | Blind vote | Final vote | Final reason |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function changeLines(item: ItemResult): string[] {
  return Object.entries(item.members).flatMap(([label, record]) =>
    record.changes.map(
      (change) => `- ${label} changed from ${change.from} to ${change.to} in round ${change.round}: ${change.reason}`,
    ),
  );
}

function itemSection(item: ItemResult): string {
  const heading =
    item.status === "agreed"
      ? `### ${item.id}: agreed on ${item.choice ?? ""} in round ${item.closedInRound ?? 0}`
      : `### ${item.id}: split`;
  const changes = changeLines(item);
  return [heading, memberTable(item), ...(changes.length > 0 ? [changes.join("\n")] : [])].join("\n\n");
}

export function renderReport(input: ReportInput): string {
  const { result } = input;
  const members = input.members.map((m) => `- ${m.label}: ${m.name} (${m.agent}, ${m.model})`).join("\n");
  const limit = result.mode === "discuss" ? ` of at most ${1 + input.maxRounds}` : "";
  const split = result.items.filter((item) => item.status === "split");
  const agreed = result.items.filter((item) => item.status === "agreed");
  return [
    `# Council run ${input.runId}`,
    [
      `- Council: ${input.council}`,
      `- Mode: ${result.mode}, rule: ${result.rule}`,
      `- Rounds: ${result.rounds}${limit}`,
      `- Items: ${result.agreed} agreed, ${result.split} split`,
    ].join("\n"),
    `## Members\n\n${members}`,
    `## Split items\n\n${split.length === 0 ? "None." : "A person decides these items.\n\n" + split.map(itemSection).join("\n\n")}`,
    `## Agreed items\n\n${agreed.length === 0 ? "None." : agreed.map(itemSection).join("\n\n")}`,
  ].join("\n\n");
}
