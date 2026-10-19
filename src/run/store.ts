import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Message, Vote } from "../domain/types.ts";

const itemVoteSchema = z.object({
  choice: z.string(),
  reason: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

const voteSchema = z.record(z.string(), itemVoteSchema);

const attemptSchema = z.object({
  prompt: z.string(),
  text: z.string(),
  status: z.enum(["done", "timeout", "error"]),
  stopReason: z.string().nullable(),
  totalTokens: z.number().nullable(),
  usage: z
    .object({
      totalTokens: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cachedReadTokens: z.number().nullish(),
      cachedWriteTokens: z.number().nullish(),
      thoughtTokens: z.number().nullish(),
    })
    .nullable()
    .optional(),
  error: z.string().nullable(),
  voteErrors: z.array(z.string()),
  durationMs: z.number(),
});

const roundRecordSchema = z.object({
  round: z.number().int().positive(),
  label: z.string(),
  status: z.enum(["voted", "no_result"]),
  body: z.string(),
  vote: voteSchema.nullable(),
  attempts: z.array(attemptSchema),
  endedAt: z.string(),
});

export type Attempt = z.infer<typeof attemptSchema>;

/** One member's work in one round: every prompt it got, every answer, and the vote that counts. */
export type RoundRecord = z.infer<typeof roundRecordSchema> & { vote: Vote | null };

/** The run folder: run.json, board.jsonl, result.json, report.md and one folder per member. */
export class RunStore {
  private readonly streams: WriteStream[] = [];
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  memberDir(label: string): string {
    return join(this.dir, "members", label.replace("member:", ""));
  }

  async init(labels: string[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const label of labels) {
      await mkdir(join(this.memberDir(label), "turns"), { recursive: true });
    }
  }

  /** Every saved round of every member, for resuming a run. */
  async loadAllRounds(labels: string[]): Promise<RoundRecord[]> {
    return (await Promise.all(labels.map((label) => this.loadRounds(label)))).flat();
  }

  /** A logger that writes one JSON line per event, with the time, to a member's `events.ndjson`. */
  eventLog(label: string): (event: Record<string, unknown>) => void {
    const write = this.log(label, "events.ndjson");
    return (event) => {
      write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    };
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readJson(name: string): Promise<unknown> {
    const text = await readFile(join(this.dir, name), "utf8").catch(() => null);
    return text === null ? null : (JSON.parse(text) as unknown);
  }

  async writeText(name: string, text: string): Promise<void> {
    await writeFile(join(this.dir, name), text);
  }

  async writeBoard(messages: Message[]): Promise<void> {
    await writeFile(join(this.dir, "board.jsonl"), messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  async saveRound(record: RoundRecord): Promise<void> {
    await writeFile(
      join(this.memberDir(record.label), "turns", `${record.round}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  async loadRounds(label: string): Promise<RoundRecord[]> {
    const dir = join(this.memberDir(label), "turns");
    const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(".json"));
    const records = await Promise.all(
      files.map(
        async (file) => roundRecordSchema.parse(JSON.parse(await readFile(join(dir, file), "utf8"))) as RoundRecord,
      ),
    );
    return records.sort((a, b) => a.round - b.round);
  }

  /** An append-only log in a member's folder, such as events.ndjson. */
  log(label: string, name: string): (line: string) => void {
    const stream = createWriteStream(join(this.memberDir(label), name), { flags: "a" });
    this.streams.push(stream);
    return (line) => {
      stream.write(line);
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      this.streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(resolve);
          }),
      ),
    );
    this.streams.length = 0;
  }
}
