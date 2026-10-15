import { createHash } from "node:crypto";
import { cp, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** A hash of every file path and file content in a folder. */
export async function hashFolder(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(`${file}\0${sha256(await readFile(join(dir, file)))}\n`);
  }
  return hash.digest("hex");
}

export async function copyFolder(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, errorOnExist: false, force: true });
}

const KEY_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Hugging Face token", pattern: /hf_[A-Za-z0-9]{30,}/ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", pattern: /xox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export type KeyFinding = { file: string; kind: string };

/** Finds strings that look like keys. It reports the file and the kind of key, never the value. */
export async function scanForKeys(dir: string): Promise<KeyFinding[]> {
  const findings: KeyFinding[] = [];
  for (const file of await listFiles(dir)) {
    const text = await readFile(join(dir, file), "utf8");
    for (const { name, pattern } of KEY_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ file, kind: name });
      }
    }
  }
  return findings;
}
