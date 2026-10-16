import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configDirs,
  findRepoConfigDir,
  listJuries,
  resolveJury,
  userConfigDir,
} from "../src/config/load.ts";
import { tempDir, writeJson } from "./helpers.ts";

async function layout(): Promise<{ root: string; user: string; repo: string; nested: string }> {
  const root = await tempDir();
  const user = join(root, "home", ".acp-jury");
  const repo = join(root, "project", ".acp-jury");
  const nested = join(root, "project", "src", "deep");
  await mkdir(nested, { recursive: true });
  await writeJson(join(user, "members.json"), {
    one: { agent: "claude", model: "opus" },
    two: { agent: "codex", model: "gpt-6-astra" },
  });
  await writeJson(join(user, "juries", "review.json"), { members: ["one"] });
  await writeJson(join(user, "juries", "solo.json"), { mode: "blind", members: ["two"] });
  await writeJson(join(repo, "juries", "review.json"), {
    mode: "discuss",
    members: ["one", "two"],
    schema: "review.schema.json",
    question: "review.md",
  });
  await writeJson(join(repo, "juries", "review.schema.json"), { type: "object" });
  await writeFile(join(repo, "juries", "review.md"), "Default question?");
  return { root, user, repo, nested };
}

describe("configuration folders", () => {
  it("uses the flag, then ACP_JURY_HOME, then the home folder", () => {
    expect(userConfigDir({}, "/x")).toBe("/x");
    expect(userConfigDir({ ACP_JURY_HOME: "/y" })).toBe("/y");
    expect(userConfigDir({})).toBe(join(homedir(), ".acp-jury"));
  });

  it("finds the nearest repo folder upward, but never the user folder", async () => {
    const { root, user, repo, nested } = await layout();
    expect(await findRepoConfigDir(nested, user)).toBe(repo);
    expect(await findRepoConfigDir(join(root, "home"), user)).toBeNull();
    expect(await configDirs({ cwd: nested, env: {}, configDir: user })).toEqual({ user, repo });
  });
});

describe("juries", () => {
  it("takes the repo jury over the user jury, and reads its schema and question", async () => {
    const { user, nested, repo } = await layout();
    const jury = await resolveJury("review", await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(jury.level).toBe("repo");
    expect(jury.settings).toMatchObject({ mode: "discuss", rounds: 5, rule: "unanimous", permissions: "read" });
    expect(jury.members.map((m) => m.name)).toEqual(["one", "two"]);
    expect(jury.schema).toEqual({ path: join(repo, "juries", "review.schema.json"), json: { type: "object" } });
    expect(jury.question?.text).toBe("Default question?");
  });

  it("uses the user jury when there is no repo jury", async () => {
    const { user, nested } = await layout();
    const jury = await resolveJury("solo", await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(jury).toMatchObject({ level: "user", schema: null, question: null });
  });

  it("replaces the user members.json with the repo one, without merging", async () => {
    const { user, nested, repo } = await layout();
    await writeJson(join(repo, "members.json"), { one: { command: ["node", "x.js"] } });
    const dirs = await configDirs({ cwd: nested, env: {}, configDir: user });
    await expect(resolveJury("review", dirs)).rejects.toThrow("does not define");
    const solo = resolveJury("solo", dirs);
    await expect(solo).rejects.toThrow(ConfigError);
  });

  it("applies overrides and checks them", async () => {
    const { user, nested } = await layout();
    const dirs = await configDirs({ cwd: nested, env: {}, configDir: user });
    const jury = await resolveJury("review", dirs, { rounds: 7, members: ["two"], rule: "majority" });
    expect(jury.settings).toMatchObject({ rounds: 7, members: ["two"], rule: "majority" });
    expect(jury.members.map((m) => m.name)).toEqual(["two"]);
    await expect(resolveJury("review", dirs, { rounds: 3 })).rejects.toThrow("overrides");
  });

  it("accepts a jury file path", async () => {
    const { root, user } = await layout();
    const path = join(root, "adhoc.json");
    await writeJson(path, { members: ["two"] });
    const jury = await resolveJury(path, { user, repo: null });
    expect(jury).toMatchObject({ name: "adhoc", level: "file", path });
  });

  it("reports unknown, invalid and broken juries", async () => {
    const { root, user } = await layout();
    const dirs = { user, repo: null };
    await expect(resolveJury("missing", dirs)).rejects.toThrow("no jury named missing");
    await expect(resolveJury("bad name", dirs)).rejects.toThrow("invalid jury name");
    await writeFile(join(user, "juries", "broken.json"), "{");
    await expect(resolveJury("broken", dirs)).rejects.toThrow("is not valid JSON");
    await writeJson(join(user, "juries", "wrong.json"), { members: [], extra: 1 });
    await expect(resolveJury("wrong", dirs)).rejects.toThrow("is not valid");
    await expect(resolveJury("review", { user: join(root, "nowhere"), repo: null })).rejects.toThrow(
      "no jury named review",
    );
    await writeJson(join(root, "lonely", "juries", "c.json"), { members: ["one"] });
    await expect(resolveJury("c", { user: join(root, "lonely"), repo: null })).rejects.toThrow("no members.json");
    await writeJson(join(user, "juries", "q.json"), { members: ["one"], question: "missing.md" });
    await expect(resolveJury("q", dirs)).rejects.toThrow("cannot read");
  });

  it("lists juries, repo first", async () => {
    const { user, nested } = await layout();
    const listings = await listJuries(await configDirs({ cwd: nested, env: {}, configDir: user }));
    expect(listings.map((l) => [l.name, l.level, l.mode])).toEqual([
      ["review", "repo", "discuss"],
      ["solo", "user", "blind"],
    ]);
  });

  it("rejects extensions on a member that is not Pi", async () => {
    const { user } = await layout();
    await writeJson(join(user, "members.json"), { one: { agent: "claude", extensions: ["x.ts"] } });
    await expect(resolveJury("review", { user, repo: null })).rejects.toThrow("only a Pi member can list extensions");
  });

  it("rejects a member with neither an agent nor a command", async () => {
    const { user } = await layout();
    await writeJson(join(user, "members.json"), { one: { model: "x" } });
    await expect(resolveJury("review", { user, repo: null })).rejects.toThrow("a member needs an agent or a command");
  });
});
