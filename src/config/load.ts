import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { councilFileSchema, membersFileSchema, type CouncilFile, type MemberConfig } from "./schema.ts";

export const CONFIG_DIR_NAME = ".acp-council";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Where the configuration came from. A council given as a file path has the level `file`. */
export type ConfigLevel = "repo" | "user" | "file";

export type ConfigDirs = {
  user: string;
  repo: string | null;
};

export type ResolvedMember = { name: string; config: MemberConfig };

export type ResolvedCouncil = {
  name: string;
  level: ConfigLevel;
  path: string;
  council: CouncilFile;
  membersPath: string;
  members: ResolvedMember[];
  schema: { path: string; json: Record<string, unknown> } | null;
  question: { path: string; text: string } | null;
};

export type CouncilListing = {
  name: string;
  level: ConfigLevel;
  path: string;
  mode: string;
  members: string[];
};

/** A council name. It has no dot, so files such as `review.schema.json` next to the councils are not councils. */
const NAME = /^[A-Za-z0-9_-]+$/;

export function userConfigDir(env: NodeJS.ProcessEnv, override?: string): string {
  return resolve(override ?? env["ACP_COUNCIL_HOME"] ?? join(homedir(), CONFIG_DIR_NAME));
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Finds the nearest `.acp-council` folder from `start` upward. The user folder is never a repo folder. */
export async function findRepoConfigDir(start: string, userDir: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_DIR_NAME);
    if (candidate !== userDir && (await isDirectory(candidate))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export async function configDirs(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
}): Promise<ConfigDirs> {
  const user = userConfigDir(options.env, options.configDir);
  return { user, repo: await findRepoConfigDir(options.cwd, user) };
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readText(path);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${path} is not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function levelDirs(dirs: ConfigDirs): { level: "repo" | "user"; dir: string }[] {
  const user = { level: "user" as const, dir: dirs.user };
  return dirs.repo === null ? [user] : [{ level: "repo" as const, dir: dirs.repo }, user];
}

/** The first file that exists, repo level first. Files are never merged. */
async function firstExisting(
  dirs: ConfigDirs,
  relative: string,
): Promise<{ level: "repo" | "user"; path: string } | null> {
  for (const { level, dir } of levelDirs(dirs)) {
    const path = join(dir, relative);
    if (await isFile(path)) {
      return { level, path };
    }
  }
  return null;
}

export async function loadMembers(dirs: ConfigDirs): Promise<{ path: string; members: Record<string, MemberConfig> }> {
  const found = await firstExisting(dirs, "members.json");
  if (found === null) {
    throw new ConfigError(
      `no members.json in ${levelDirs(dirs)
        .map(({ dir }) => dir)
        .join(" or ")}`,
    );
  }
  return { path: found.path, members: await readJsonFile(found.path, membersFileSchema) };
}

async function locateCouncil(
  name: string,
  dirs: ConfigDirs,
): Promise<{ name: string; level: ConfigLevel; path: string }> {
  if (name.endsWith(".json") || name.includes("/")) {
    return { name: basename(name, ".json"), level: "file", path: resolve(name) };
  }
  if (!NAME.test(name)) {
    throw new ConfigError(`invalid council name: ${name}`);
  }
  const found = await firstExisting(dirs, join("councils", `${name}.json`));
  if (found === null) {
    throw new ConfigError(
      `no council named ${name} in ${levelDirs(dirs)
        .map(({ dir }) => join(dir, "councils"))
        .join(" or ")}`,
    );
  }
  return { name, ...found };
}

const objectSchema = z.record(z.string(), z.unknown());

async function optionalFile(
  base: string,
  relative: string | undefined,
): Promise<{ path: string; text: string } | null> {
  if (relative === undefined) {
    return null;
  }
  const path = resolve(base, relative);
  return { path, text: await readText(path) };
}

/** Fields that a caller can change for one run. The result is checked again, so a run cannot break a council's rules. */
export type CouncilOverrides = Partial<Pick<CouncilFile, "mode" | "members" | "rounds" | "rule">>;

function applyOverrides(path: string, council: CouncilFile, overrides: CouncilOverrides): CouncilFile {
  const parsed = councilFileSchema.safeParse({ ...council, ...overrides });
  if (!parsed.success) {
    throw new ConfigError(`the overrides for ${path} are not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function resolveCouncil(
  name: string,
  dirs: ConfigDirs,
  overrides: CouncilOverrides = {},
): Promise<ResolvedCouncil> {
  const located = await locateCouncil(name, dirs);
  const council = applyOverrides(located.path, await readJsonFile(located.path, councilFileSchema), overrides);
  const { path: membersPath, members } = await loadMembers(dirs);
  const resolvedMembers = council.members.map((memberName) => {
    const config = members[memberName];
    if (config === undefined) {
      throw new ConfigError(
        `council ${located.name} names the member ${memberName}, which ${membersPath} does not define`,
      );
    }
    return { name: memberName, config };
  });
  const base = dirname(located.path);
  const schemaPath = council.schema === undefined ? null : resolve(base, council.schema);
  return {
    ...located,
    council,
    membersPath,
    members: resolvedMembers,
    schema: schemaPath === null ? null : { path: schemaPath, json: await readJsonFile(schemaPath, objectSchema) },
    question: await optionalFile(base, council.question),
  };
}

async function councilNames(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, "councils")).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => basename(entry, ".json"))
    .filter((name) => NAME.test(name));
}

export async function listCouncils(dirs: ConfigDirs): Promise<CouncilListing[]> {
  const listings = new Map<string, CouncilListing>();
  for (const { level, dir } of levelDirs(dirs)) {
    for (const name of await councilNames(dir)) {
      if (!listings.has(name)) {
        const path = join(dir, "councils", `${name}.json`);
        const council = await readJsonFile(path, councilFileSchema);
        listings.set(name, { name, level, path, mode: council.mode, members: council.members });
      }
    }
  }
  return [...listings.values()].sort((a, b) => a.name.localeCompare(b.name));
}
