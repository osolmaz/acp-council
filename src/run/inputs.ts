import { randomBytes } from "node:crypto";
import type { ResolvedJury } from "../config/load.ts";
import type { Item } from "../domain/types.ts";
import { DEFAULT_VOTE_SCHEMA } from "../domain/vote.ts";
import { RunError } from "./errors.ts";
import { hashFolder, sha256 } from "./files.ts";
import type { RunStore } from "./store.ts";

export type RunInputs = Record<string, string>;

/** A sortable run ID: the UTC time and a random suffix. */
export function newRunId(now = new Date()): string {
  const time = now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${time}-${randomBytes(3).toString("hex")}`;
}

/** Hashes of everything that decides a run's answers. A run resumes only when they are the same. */
export async function hashInputs(
  jury: ResolvedJury,
  question: string,
  items: Item[],
  folder: string,
): Promise<RunInputs> {
  return {
    question: sha256(question),
    items: sha256(JSON.stringify(items)),
    jury: sha256(JSON.stringify(jury.settings)),
    members: sha256(JSON.stringify(jury.members)),
    schema: sha256(JSON.stringify(jury.schema?.json ?? DEFAULT_VOTE_SCHEMA)),
    folder: await hashFolder(folder),
  };
}

export async function assertResumable(store: RunStore, inputs: RunInputs): Promise<void> {
  const previous = await store.readJson("run.json");
  const previousInputs =
    typeof previous === "object" && previous !== null && "inputs" in previous ? previous.inputs : undefined;
  if (previous !== null && JSON.stringify(previousInputs) !== JSON.stringify(inputs)) {
    throw new RunError(`the run folder ${store.dir} holds a run with other inputs; use another run ID`);
  }
}
