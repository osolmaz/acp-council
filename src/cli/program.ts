import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  ConfigError,
  configDirs,
  isJuryPath,
  listJuries,
  readJsonFile,
  readText,
  resolveJury,
  type ConfigDirs,
  type JuryOverrides,
  type ResolvedJury,
} from "../config/load.ts";
import { itemsFileSchema } from "../config/schema.ts";
import { RunError } from "../run/errors.ts";
import type { Progress } from "../run/rounds.ts";
import { runJury } from "../run/runner.ts";
import { VERSION } from "../meta/version.ts";

export type Io = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type RunFlags = {
  dir: string;
  question?: string;
  items?: string;
  mode?: "blind" | "discuss";
  members?: string[];
  rounds?: number;
  rule?: "unanimous" | "majority";
  runId?: string;
  out?: string;
  configDir?: string;
};

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("not an integer");
  }
  return parsed;
}

function oneOf<T extends string>(values: readonly T[]): (value: string) => T {
  return (value) => {
    const match = values.find((candidate) => candidate === value);
    if (match === undefined) {
      throw new InvalidArgumentError(`expected one of: ${values.join(", ")}`);
    }
    return match;
  };
}

function overridesFrom(flags: RunFlags): JuryOverrides {
  return {
    ...(flags.mode === undefined ? {} : { mode: flags.mode }),
    ...(flags.members === undefined ? {} : { members: flags.members }),
    ...(flags.rounds === undefined ? {} : { rounds: flags.rounds }),
    ...(flags.rule === undefined ? {} : { rule: flags.rule }),
  };
}

/** Runs go next to the configuration that holds the jury: `<config folder>/runs/<run id>`. */
export function defaultOutDir(jury: ResolvedJury, dirs: ConfigDirs): string {
  const folders: Record<ResolvedJury["level"], string> = {
    repo: dirs.repo ?? dirs.user,
    user: dirs.user,
    file: dirname(jury.path),
  };
  return join(folders[jury.level], "runs");
}

/** A path relative to the working folder when it is inside it, so that output stays short. */
export function shortPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

async function questionText(flags: RunFlags, jury: ResolvedJury, io: Io): Promise<string> {
  if (flags.question !== undefined) {
    return readText(resolve(io.cwd, flags.question));
  }
  if (jury.question !== null) {
    return jury.question.text;
  }
  throw new ConfigError(`jury ${jury.name} has no default question; give one with --question`);
}

function describeProgress(progress: Progress): string {
  if (progress.type === "round") {
    return `round ${progress.round}: open items ${progress.openItems.join(", ")}\n`;
  }
  const status = progress.status === "voted" ? "voted" : "gave no result";
  return `round ${progress.round}: ${progress.label} (${progress.name}) ${status}${progress.reused ? " (saved)" : ""}\n`;
}

async function runCommand(name: string, flags: RunFlags, io: Io): Promise<void> {
  const dirs = await configDirs({
    cwd: io.cwd,
    env: io.env,
    ...(flags.configDir === undefined ? {} : { configDir: flags.configDir }),
  });
  const target = isJuryPath(name) ? resolve(io.cwd, name) : name;
  const jury = await resolveJury(target, dirs, overridesFrom(flags));
  const outDir = flags.out === undefined ? defaultOutDir(jury, dirs) : resolve(io.cwd, flags.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, ".gitignore"), "*\n");
  const outcome = await runJury({
    jury,
    folder: resolve(io.cwd, flags.dir),
    question: await questionText(flags, jury, io),
    ...(flags.items === undefined ? {} : { items: await readJsonFile(resolve(io.cwd, flags.items), itemsFileSchema) }),
    outDir,
    ...(flags.runId === undefined ? {} : { runId: flags.runId }),
    onProgress: (progress) => {
      io.stderr(describeProgress(progress));
    },
  });
  const { result } = outcome;
  io.stdout(
    `run ${outcome.runId}: ${result.agreed} agreed, ${result.split} split after ${result.rounds} round(s) (${outcome.stop})\nreport: ${shortPath(join(outcome.runDir, "report.md"), io.cwd)}\n`,
  );
}

async function showCommand(runDir: string, io: Io): Promise<void> {
  io.stdout(await readText(join(resolve(io.cwd, runDir), "report.md")));
}

async function juriesCommand(flags: { configDir?: string }, io: Io): Promise<void> {
  const dirs = await configDirs({
    cwd: io.cwd,
    env: io.env,
    ...(flags.configDir === undefined ? {} : { configDir: flags.configDir }),
  });
  const listings = await listJuries(dirs);
  if (listings.length === 0) {
    io.stdout(`no juries in ${[dirs.repo, dirs.user].filter((dir) => dir !== null).join(" or ")}\n`);
    return;
  }
  for (const listing of listings) {
    io.stdout(`${listing.name}\t${listing.mode}\t${listing.members.join(",")}\t${listing.level}\t${listing.path}\n`);
  }
}

function program(io: Io): Command {
  const root = new Command("acp-jury")
    .description("Ask a jury of coding agents one question about a folder.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  root
    .command("run")
    .description("run a jury on a folder")
    .argument("<jury>", "a jury name, or the path of a jury file")
    .requiredOption("--dir <folder>", "the read-only folder that the members read")
    .option("--question <file>", "the question file; the default is the jury's question")
    .option("--items <file>", "a JSON list of {id, text} items to vote on")
    .option("--mode <mode>", "blind or discuss", oneOf(["blind", "discuss"] as const))
    .option("--members <names>", "comma-separated member names", (value) => value.split(","))
    .option("--rounds <n>", "the most discussion rounds after the blind round (at least 5)", integer)
    .option("--rule <rule>", "unanimous or majority", oneOf(["unanimous", "majority"] as const))
    .option("--run-id <id>", "a run ID; a rerun with the same ID resumes the run")
    .option("--out <dir>", "the parent folder of the run folder")
    .option("--config-dir <dir>", "the user configuration folder")
    .action((name: string, flags: RunFlags) => runCommand(name, flags, io));
  root
    .command("show")
    .description("print the report of a run")
    .argument("<run folder>")
    .action((runDir: string) => showCommand(runDir, io));
  root
    .command("juries")
    .description("list the juries and the file each one comes from")
    .option("--config-dir <dir>", "the user configuration folder")
    .action((flags: { configDir?: string }) => juriesCommand(flags, io));
  return root;
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    await program(io).parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof ConfigError || error instanceof RunError) {
      io.stderr(`acp-jury: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
