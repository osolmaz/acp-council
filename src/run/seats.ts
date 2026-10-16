import { planLaunch } from "../agents/registry.ts";
import type { LaunchPlan } from "../agents/profile.ts";
import type { ResolvedJury } from "../config/load.ts";
import type { Item } from "../domain/types.ts";
import type { VoteSchema } from "../domain/vote.ts";
import { Member } from "./member.ts";
import type { Seat } from "./rounds.ts";
import type { RunStore } from "./store.ts";
import type { Workspace } from "./workspace.ts";

export type SeatedMember = Seat & { plan: LaunchPlan };

export type SeatingOptions = {
  jury: ResolvedJury;
  labels: string[];
  folder: string;
  question: string;
  items: Item[];
  schema: VoteSchema;
};

const START_TIMEOUT_MS = 300_000;

/** Gives every member a label, a private copy of the folder, a launch plan and its record logs. */
export async function seatMembers(
  options: SeatingOptions,
  workspace: Workspace,
  store: RunStore,
): Promise<SeatedMember[]> {
  const { jury } = options;
  const permissions = jury.settings.permissions;
  const seats: SeatedMember[] = [];
  for (const [index, { name, config }] of jury.members.entries()) {
    const label = options.labels[index] ?? "";
    const { scratchDir, workDir } = await workspace.seat(label, options.folder);
    const plan = await planLaunch(config, permissions, scratchDir);
    const spec = {
      label,
      plan,
      model: config.model,
      options: config.options ?? {},
      workDir,
      permissions,
      startTimeoutMs: START_TIMEOUT_MS,
    };
    const intro = {
      label,
      memberCount: jury.members.length,
      question: options.question,
      items: options.items,
      schema: options.schema,
    };
    const hooks = { onEvent: store.eventLog(label), onStderr: store.log(label, "stderr.log") };
    seats.push({ name, plan, member: new Member(spec, intro, options.schema, hooks) });
  }
  return seats;
}
