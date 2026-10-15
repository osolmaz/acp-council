import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import type { MemberConfig } from "../src/config/schema.ts";

export const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fake-agent.ts");

export type FakeEntry = {
  reply?: string;
  delayMs?: number;
  crash?: boolean;
  permission?: string;
  readFile?: string;
  writeFile?: string;
  totalTokens?: number;
};

export type FakeScript = {
  models?: string[];
  rounds?: Record<string, FakeEntry>;
  nudge?: FakeEntry;
  failSessionNew?: boolean;
};

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temporary folder that is removed after the test file. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-council-test-"));
  created.push(dir, `${dir}-copy`);
  return dir;
}

/** A reply that ends with a vote block. */
export function reply(text: string, votes: Record<string, [string, string]>): string {
  const vote = Object.fromEntries(Object.entries(votes).map(([id, [choice, reason]]) => [id, { choice, reason }]));
  return `${text}\n\n\`\`\`json\n${JSON.stringify(vote)}\n\`\`\`\n`;
}

/** Writes a fake agent script and returns a member that runs it, with its prompt log. */
export async function fakeMember(
  dir: string,
  name: string,
  script: FakeScript,
  extra: Partial<MemberConfig> = {},
): Promise<{ config: MemberConfig; log: string }> {
  const scriptPath = join(dir, `${name}.script.json`);
  const log = join(dir, `${name}.log`);
  await writeFile(scriptPath, JSON.stringify(script));
  return { config: { command: [process.execPath, FAKE_AGENT, scriptPath, log], ...extra }, log };
}

export async function readLog(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function prompts(path: string): Promise<string[]> {
  return (await readLog(path)).flatMap((entry) => (typeof entry["prompt"] === "string" ? [entry["prompt"]] : []));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

export async function folderWith(dir: string, files: Record<string, string>): Promise<string> {
  const folder = join(dir, "folder");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, name)), { recursive: true });
    await writeFile(join(folder, name), content);
  }
  return folder;
}
