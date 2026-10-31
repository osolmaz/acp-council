import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configDirs,
  findRepoConfigDir,
  listCouncils,
  resolveCouncil,
  userConfigDir,
} from "../src/config/load.ts";
import { tempDir, writeJson } from "./helpers.ts";

async function layout(): Promise<{ root: string; user: string; repo: string; nested: string }> {
  const root = await tempDir();
  const user = join(root, "home", ".acp-council");
  const repo = join(root, "project", ".acp-council");
  const nested = join(root, "project", "src", "deep");
  await mkdir(nested, { recursive: true });
  await writeJson(join(user, "members.json"), {
    one: { agent: "claude", model: "opus" },
    two: { agent: "codex", model: "gpt-6-astra" },
  });
  await writeJson(join(user, "councils", "review.json"), { members: ["one"] });
  await writeJson(join(user, "councils", "solo.json"), { mode: "blind", members: ["two"] });
  await writeJson(join(repo, "councils", "review.json"), {
    mode: "discuss",
    members: ["one", "two"],
    schema: "review.schema.json",
    question: "review.md",
  });
  await writeJson(join(repo, "councils", "review.schema.json"), { type: "object" });
  await writeFile(join(repo, "councils", "review.md"), "Default question?");
  return { root, user, repo, nested };
}

describe("configuration folders", () => {
  it("uses the flag, then ACP_COUNCIL_HOME, then the home folder", () => {
    expect(userConfigDir({}, "/x")).toBe("/x");
    expect(userConfigDir({ ACP_COUNCIL_HOME: "/y" })).toBe("/y");
    expect(userConfigDir({})).toBe(join(homedir(), ".acp-council"));
  });

  it("finds the nearest repo folder upward, but never the user folder", async () => {
    const { root, user, repo, nested } = await layout();
    expect(await findRepoConfigDir(nested, user)).toBe(repo);
    expect(await findRepoConfigDir(join(root, "home"), user)).toBeNull();
    expect(await configDirs({ cwd: nested, env: {}, configDir: user })).toEqual({ user, repo });
  });
});

describe("councils", () => {
  it("takes the repo council over the user council, and reads its schema and question", async () => {
    const { user, nested, repo } = await layout();
    const council = await resolveCouncil("review", await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(council.level).toBe("repo");
    expect(council.settings).toMatchObject({ mode: "discuss", rounds: 5, rule: "unanimous", permissions: "read" });
    expect(council.members.map((m) => m.name)).toEqual(["one", "two"]);
    expect(council.schema).toEqual({ path: join(repo, "councils", "review.schema.json"), json: { type: "object" } });
    expect(council.question?.text).toBe("Default question?");
  });

  it("uses the user council when there is no repo council", async () => {
    const { user, nested } = await layout();
    const council = await resolveCouncil("solo", await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(council).toMatchObject({ level: "user", schema: null, question: null });
  });

  it("replaces the user members.json with the repo one, without merging", async () => {
    const { user, nested, repo } = await layout();
    await writeJson(join(repo, "members.json"), { one: { command: ["node", "x.js"] } });
    const dirs = await configDirs({ cwd: nested, env: {}, configDir: user });
    await expect(resolveCouncil("review", dirs)).rejects.toThrow("does not define");
    const solo = resolveCouncil("solo", dirs);
    await expect(solo).rejects.toThrow(ConfigError);
  });

  it("applies overrides and checks them", async () => {
    const { user, nested } = await layout();
    const dirs = await configDirs({ cwd: nested, env: {}, configDir: user });
    const council = await resolveCouncil("review", dirs, { rounds: 7, members: ["two"], rule: "majority" });
    expect(council.settings).toMatchObject({ rounds: 7, members: ["two"], rule: "majority" });
    expect(council.members.map((m) => m.name)).toEqual(["two"]);
    await expect(resolveCouncil("review", dirs, { rounds: 3 })).rejects.toThrow("overrides");
  });

  it("accepts a council file path", async () => {
    const { root, user } = await layout();
    const path = join(root, "adhoc.json");
    await writeJson(path, { members: ["two"] });
    const council = await resolveCouncil(path, { user, repo: null });
    expect(council).toMatchObject({ name: "adhoc", level: "file", path });
  });

  it("reports unknown, invalid and broken councils", async () => {
    const { root, user } = await layout();
    const dirs = { user, repo: null };
    await expect(resolveCouncil("missing", dirs)).rejects.toThrow("no council named missing");
    await expect(resolveCouncil("bad name", dirs)).rejects.toThrow("invalid council name");
    await writeFile(join(user, "councils", "broken.json"), "{");
    await expect(resolveCouncil("broken", dirs)).rejects.toThrow("is not valid JSON");
    await writeJson(join(user, "councils", "wrong.json"), { members: [], extra: 1 });
    await expect(resolveCouncil("wrong", dirs)).rejects.toThrow("is not valid");
    await expect(resolveCouncil("review", { user: join(root, "nowhere"), repo: null })).rejects.toThrow(
      "no council named review",
    );
    await writeJson(join(root, "lonely", "councils", "c.json"), { members: ["one"] });
    await expect(resolveCouncil("c", { user: join(root, "lonely"), repo: null })).rejects.toThrow("no members.json");
    await writeJson(join(user, "councils", "q.json"), { members: ["one"], question: "missing.md" });
    await expect(resolveCouncil("q", dirs)).rejects.toThrow("cannot read");
  });

  it("lists councils, repo first", async () => {
    const { user, nested } = await layout();
    const listings = await listCouncils(await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(listings.map((l) => [l.name, l.level, l.mode])).toEqual([
      ["review", "repo", "discuss"],
      ["solo", "user", "blind"],
    ]);
  });

  it("rejects extensions on a member that is not Pi", async () => {
    const { user } = await layout();
    await writeJson(join(user, "members.json"), { one: { agent: "claude", extensions: ["x.ts"] } });
    await expect(resolveCouncil("review", { user, repo: null })).rejects.toThrow(
      "only a Pi member can list extensions",
    );
  });

  it("rejects a member with neither an agent nor a command", async () => {
    const { user } = await layout();
    await writeJson(join(user, "members.json"), { one: { model: "x" } });
    await expect(resolveCouncil("review", { user, repo: null })).rejects.toThrow(
      "a member needs an agent or a command",
    );
  });
});
