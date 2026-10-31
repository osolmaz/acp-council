import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  ConfigError,
  configDirs,
  isCouncilPath,
  listCouncils,
  readJsonFile,
  readText,
  resolveCouncil,
  type ConfigDirs,
  type CouncilOverrides,
  type ResolvedCouncil,
} from "../config/load.ts";
import { itemsFileSchema } from "../config/schema.ts";
import { RunError } from "../run/errors.ts";
import type { Progress } from "../run/rounds.ts";
import { runCouncil } from "../run/runner.ts";
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

function overridesFrom(flags: RunFlags): CouncilOverrides {
  return {
    ...(flags.mode === undefined ? {} : { mode: flags.mode }),
    ...(flags.members === undefined ? {} : { members: flags.members }),
    ...(flags.rounds === undefined ? {} : { rounds: flags.rounds }),
    ...(flags.rule === undefined ? {} : { rule: flags.rule }),
  };
}

/** Runs go next to the configuration that holds the council: `<config folder>/runs/<run id>`. */
export function defaultOutDir(council: ResolvedCouncil, dirs: ConfigDirs): string {
  const folders: Record<ResolvedCouncil["level"], string> = {
    repo: dirs.repo ?? dirs.user,
    user: dirs.user,
    file: dirname(council.path),
  };
  return join(folders[council.level], "runs");
}

/** A path relative to the working folder when it is inside it, so that output stays short. */
export function shortPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

async function questionText(flags: RunFlags, council: ResolvedCouncil, io: Io): Promise<string> {
  if (flags.question !== undefined) {
    return readText(resolve(io.cwd, flags.question));
  }
  if (council.question !== null) {
    return council.question.text;
  }
  throw new ConfigError(`council ${council.name} has no default question; give one with --question`);
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
  const target = isCouncilPath(name) ? resolve(io.cwd, name) : name;
  const council = await resolveCouncil(target, dirs, overridesFrom(flags));
  const outDir = flags.out === undefined ? defaultOutDir(council, dirs) : resolve(io.cwd, flags.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, ".gitignore"), "*\n");
  const outcome = await runCouncil({
    council,
    folder: resolve(io.cwd, flags.dir),
    question: await questionText(flags, council, io),
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

async function councilsCommand(flags: { configDir?: string }, io: Io): Promise<void> {
  const dirs = await configDirs({
    cwd: io.cwd,
    env: io.env,
    ...(flags.configDir === undefined ? {} : { configDir: flags.configDir }),
  });
  const listings = await listCouncils(dirs);
  if (listings.length === 0) {
    io.stdout(`no councils in ${[dirs.repo, dirs.user].filter((dir) => dir !== null).join(" or ")}\n`);
    return;
  }
  for (const listing of listings) {
    io.stdout(`${listing.name}\t${listing.mode}\t${listing.members.join(",")}\t${listing.level}\t${listing.path}\n`);
  }
}

function program(io: Io): Command {
  const root = new Command("acp-council")
    .description("Ask a council of coding agents one question about a folder.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  root
    .command("run")
    .description("run a council on a folder")
    .argument("<council>", "a council name, or the path of a council file")
    .requiredOption("--dir <folder>", "the read-only folder that the members read")
    .option("--question <file>", "the question file; the default is the council's question")
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
    .command("councils")
    .description("list the councils and the file each one comes from")
    .option("--config-dir <dir>", "the user configuration folder")
    .action((flags: { configDir?: string }) => councilsCommand(flags, io));
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
      io.stderr(`acp-council: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
