import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultOutDir, main, shortPath, type Io } from "../src/cli/program.ts";
import type { ResolvedJury } from "../src/config/load.ts";
import { VERSION } from "../src/meta/version.ts";
import { fakeMember, folderWith, reply, tempDir, writeJson } from "./helpers.ts";

type Captured = Io & { out: string[]; err: string[] };

function io(cwd: string, env: NodeJS.ProcessEnv = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd, env, out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

async function userConfig(): Promise<{ dir: string; user: string; folder: string }> {
  const dir = await tempDir();
  const user = join(dir, "user");
  const folder = await folderWith(dir, { "doc.txt": "text" });
  const one = await fakeMember(dir, "one", { rounds: { "*": { reply: reply("One.", { answer: ["yes", "r"] }) } } });
  const two = await fakeMember(dir, "two", { rounds: { "*": { reply: reply("Two.", { answer: ["yes", "s"] }) } } });
  await writeJson(join(user, "members.json"), { one: one.config, two: two.config });
  await writeJson(join(user, "juries", "pair.json"), {
    mode: "discuss",
    members: ["one", "two"],
    question: "pair.md",
  });
  await writeFile(join(user, "juries", "pair.md"), "Is the document fine?");
  return { dir, user, folder };
}

describe("cli", () => {
  it("runs a jury from the user folder, and shows its report", async () => {
    const { dir, user } = await userConfig();
    const run = io(dir, { ACP_JURY_HOME: user });
    expect(await main(["run", "pair", "--dir", "folder", "--run-id", "r1"], run)).toBe(0);
    expect(run.out.join("")).toContain("run r1: 1 agreed, 0 split after 1 round(s) (all_agreed)");
    expect(run.err.join("")).toContain("round 1: member:A (one) voted");
    const runs = join(user, "runs");
    expect(await readFile(join(runs, ".gitignore"), "utf8")).toBe("*\n");
    expect(await readdir(runs)).toContain("r1");
    const show = io(dir);
    expect(await main(["show", join(runs, "r1")], show)).toBe(0);
    expect(show.out.join("")).toContain("# Jury run r1");
  });

  it("takes items, a question file, overrides and an output folder", async () => {
    const { dir, user } = await userConfig();
    await writeJson(join(dir, "items.json"), [{ id: "answer", text: "the only item" }]);
    await writeFile(join(dir, "q.md"), "Other question?");
    const run = io(dir);
    const code = await main(
      [
        "run",
        "pair",
        "--dir",
        "folder",
        "--items",
        "items.json",
        "--question",
        "q.md",
        "--mode",
        "blind",
        "--members",
        "one",
        "--rounds",
        "6",
        "--rule",
        "majority",
        "--out",
        "out",
        "--config-dir",
        user,
        "--run-id",
        "r2",
      ],
      run,
    );
    expect(code).toBe(0);
    const runJson = JSON.parse(await readFile(join(dir, "out", "r2", "run.json"), "utf8")) as Record<string, unknown>;
    expect(runJson).toMatchObject({
      question: "Other question?",
      jury: { mode: "blind", rounds: 6, rule: "majority", members: ["one"] },
    });
  });

  it("writes a run next to a jury file given as a path", async () => {
    const { dir, user } = await userConfig();
    await writeJson(join(dir, "adhoc", "jury.json"), { members: ["one"] });
    const run = io(dir, { ACP_JURY_HOME: user });
    expect(
      await main(["run", "adhoc/jury.json", "--dir", "folder", "--question", "folder/doc.txt", "--run-id", "f1"], run),
    ).toBe(0);
    expect(await readdir(join(dir, "adhoc", "runs"))).toContain("f1");
    expect(run.out.join("")).toContain(`report: ${join("adhoc", "runs", "f1", "report.md")}\n`);
  });

  it("shortens only paths inside the working folder", () => {
    expect(shortPath("/w/a/b.md", "/w")).toBe("a/b.md");
    expect(shortPath("/x/b.md", "/w")).toBe("/x/b.md");
  });

  it("picks the runs folder of the level that holds the jury", () => {
    const jury = (level: ResolvedJury["level"]): ResolvedJury => ({ level, path: "/x/c.json" }) as ResolvedJury;
    const dirs = { user: "/u", repo: "/r" };
    expect(defaultOutDir(jury("repo"), dirs)).toBe("/r/runs");
    expect(defaultOutDir(jury("user"), dirs)).toBe("/u/runs");
    expect(defaultOutDir(jury("file"), dirs)).toBe("/x/runs");
    expect(defaultOutDir(jury("repo"), { user: "/u", repo: null })).toBe("/u/runs");
  });

  it("lists juries", async () => {
    const { dir, user } = await userConfig();
    const list = io(dir, { ACP_JURY_HOME: user });
    expect(await main(["juries"], list)).toBe(0);
    expect(list.out.join("")).toContain(`pair\tdiscuss\tone,two\tuser\t${join(user, "juries", "pair.json")}`);
    const empty = io(dir);
    expect(await main(["juries", "--config-dir", join(dir, "none")], empty)).toBe(0);
    expect(empty.out.join("")).toContain("no juries in");
  });

  it("reports errors with an exit code", async () => {
    const { dir, user } = await userConfig();
    const missing = io(dir, { ACP_JURY_HOME: user });
    expect(await main(["run", "nope", "--dir", "folder"], missing)).toBe(1);
    expect(missing.err.join("")).toContain("acp-jury: no jury named nope");
    const rounds = io(dir, { ACP_JURY_HOME: user });
    expect(await main(["run", "pair", "--dir", "folder", "--rounds", "3"], rounds)).toBe(1);
    expect(await main(["run", "pair", "--dir", "folder", "--rounds", "x"], io(dir))).not.toBe(0);
    expect(await main(["run", "pair", "--dir", "folder", "--mode", "debate"], io(dir))).not.toBe(0);
    expect(await main(["run", "pair"], io(dir))).not.toBe(0);
    await writeJson(join(user, "juries", "bare.json"), { members: ["one"] });
    const noQuestion = io(dir, { ACP_JURY_HOME: user });
    expect(await main(["run", "bare", "--dir", "folder"], noQuestion)).toBe(1);
    expect(noQuestion.err.join("")).toContain("has no default question");
  });

  it("prints its version", async () => {
    const version = io(process.cwd());
    expect(await main(["--version"], version)).toBe(0);
    expect(version.out.join("")).toBe(`${VERSION}\n`);
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
