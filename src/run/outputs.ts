import type { ResolvedCouncil } from "../config/load.ts";
import { renderReport } from "../domain/report.ts";
import type { CouncilResult } from "../domain/types.ts";
import { VERSION } from "../meta/version.ts";
import { RunError } from "./errors.ts";
import { scanForKeys } from "./files.ts";
import type { RunInputs } from "./inputs.ts";
import type { StopReason } from "./rounds.ts";
import type { SeatedMember } from "./seats.ts";
import type { RunStore } from "./store.ts";

export type RunHeader = {
  runId: string;
  council: ResolvedCouncil;
  question: string;
  folder: string;
  inputs: RunInputs;
};

/** run.json: the inputs, the resolved council, the label map and how each member ran. */
export async function writeRunJson(store: RunStore, header: RunHeader, seats: SeatedMember[]): Promise<void> {
  const { council } = header;
  await store.writeJson("run.json", {
    runId: header.runId,
    acpCouncilVersion: VERSION,
    council: {
      name: council.name,
      level: council.level,
      path: council.path,
      membersPath: council.membersPath,
      ...council.council,
    },
    question: header.question,
    folder: header.folder,
    members: seats.map((seat) => ({
      label: seat.member.label,
      name: seat.name,
      config: council.members.find((member) => member.name === seat.name)?.config ?? null,
      command: seat.plan.command,
      clean: seat.plan.clean,
      cleanNote: seat.plan.cleanNote,
      session: seat.member.info,
    })),
    inputs: header.inputs,
  });
}

/** result.json and report.md. */
export async function writeResult(
  store: RunStore,
  header: RunHeader,
  seats: SeatedMember[],
  outcome: { stop: StopReason; result: CouncilResult },
): Promise<void> {
  await store.writeJson("result.json", { stop: outcome.stop, ...outcome.result });
  const members = seats.map((seat) => ({
    label: seat.member.label,
    name: seat.name,
    agent: seat.plan.agent ?? "custom",
    model: seat.member.spec.model ?? "default",
  }));
  const report = renderReport({
    runId: header.runId,
    council: header.council.name,
    maxRounds: header.council.council.rounds,
    members,
    result: outcome.result,
  });
  await store.writeText("report.md", report);
}

/** Calls the caller's backup hook, after a key scan of the run folder finds no key. */
export async function backupRun(
  runDir: string,
  backup: ((runDir: string) => Promise<void>) | undefined,
): Promise<void> {
  if (backup === undefined) {
    return;
  }
  const findings = await scanForKeys(runDir);
  if (findings.length > 0) {
    const list = findings.map((finding) => `${finding.file} (${finding.kind})`).join(", ");
    throw new RunError(`backup blocked: the run folder holds what looks like a key: ${list}`);
  }
  await backup(runDir);
}
