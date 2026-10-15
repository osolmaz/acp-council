import { access, constants, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { ADAPTERS, planLaunch } from "../src/acp/agents.ts";
import { findModelOption, planOptions, selectValues } from "../src/acp/options.ts";
import { choosePermission, readInside, sliceLines } from "../src/acp/policy.ts";
import { copyFolder, hashFolder, scanForKeys } from "../src/run/files.ts";
import { tempDir } from "./helpers.ts";

const model: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus 5.5" },
    { value: "sonnet", name: "Sonnet 5.5" },
  ],
};

const effort: SessionConfigOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    {
      group: "levels",
      name: "Levels",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ],
};

describe("config options", () => {
  it("flattens grouped values and ignores boolean options", () => {
    expect(selectValues(effort).map((v) => v.value)).toEqual(["low", "high"]);
    expect(selectValues({ id: "b", name: "B", type: "boolean", currentValue: true })).toEqual([]);
  });

  it("finds the model option by id first", () => {
    const other: SessionConfigOption = { ...model, id: "alt" };
    expect(findModelOption([other, model])?.id).toBe("model");
    expect(findModelOption([other])?.id).toBe("alt");
    expect(findModelOption([effort])).toBeUndefined();
  });

  it("matches a value or a display name", () => {
    expect(planOptions([model, effort], "Opus 5.5", { effort: "low" })).toEqual([
      { configId: "model", value: "opus", name: "Opus 5.5" },
      { configId: "effort", value: "low", name: "Low" },
    ]);
    expect(planOptions([model], undefined, {})).toEqual([]);
  });

  it("explains what the agent offers when a value is wrong", () => {
    expect(() => planOptions([model], "gpt", {})).toThrow("it offers: opus (Opus 5.5), sonnet (Sonnet 5.5)");
    expect(() => planOptions([effort], "opus", {})).toThrow("has no model option");
    expect(() => planOptions([model], undefined, { mode: "x" })).toThrow("has no config option mode; it has: model");
  });
});

describe("permissions", () => {
  const request = (kind: RequestPermissionRequest["toolCall"]["kind"]): RequestPermissionRequest => ({
    sessionId: "s",
    toolCall: { toolCallId: "t", ...(kind === undefined ? {} : { kind }) },
    options: [
      { optionId: "ok", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  });

  it("allows reading and denies editing", () => {
    expect(choosePermission(request("read"), "read").outcome).toEqual({ outcome: "selected", optionId: "ok" });
    expect(choosePermission(request("edit"), "read").outcome).toEqual({ outcome: "selected", optionId: "no" });
    expect(choosePermission(request(undefined), "read").outcome).toEqual({ outcome: "selected", optionId: "no" });
  });

  it("allows commands only under exec", () => {
    expect(choosePermission(request("execute"), "read").outcome).toEqual({ outcome: "selected", optionId: "no" });
    expect(choosePermission(request("execute"), "exec").outcome).toEqual({ outcome: "selected", optionId: "ok" });
  });

  it("prefers a refusal that does not cancel the turn, and allows extra kinds from the profile", () => {
    const codex: RequestPermissionRequest = {
      ...request("execute"),
      options: [
        { optionId: "approved", name: "Yes", kind: "allow_once" },
        { optionId: "cancel", name: "Cancel", kind: "reject_once" },
        { optionId: "decline", name: "No", kind: "reject_once" },
      ],
    };
    expect(choosePermission(codex, "read").outcome).toEqual({ outcome: "selected", optionId: "decline" });
    expect(choosePermission(codex, "read", ["execute"]).outcome).toEqual({ outcome: "selected", optionId: "approved" });
    const onlyCancel = { ...codex, options: [{ optionId: "cancel", name: "Cancel", kind: "reject_once" as const }] };
    expect(choosePermission(onlyCancel, "read").outcome).toEqual({ outcome: "selected", optionId: "cancel" });
  });

  it("cancels when no option fits", () => {
    expect(choosePermission({ ...request("edit"), options: [] }, "read").outcome).toEqual({ outcome: "cancelled" });
  });
});

describe("file reads", () => {
  it("reads inside the folder, with line ranges", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.txt"), "1\n2\n3\n4");
    expect(await readInside(dir, "a.txt")).toBe("1\n2\n3\n4");
    expect(await readInside(dir, join(dir, "a.txt"), 2, 2)).toBe("2\n3");
    expect(sliceLines("1\n2\n3", null, 1)).toBe("1");
    expect(sliceLines("1\n2\n3", 3, null)).toBe("3");
  });

  it("refuses paths and links that leave the folder", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "inner"));
    await writeFile(join(dir, "secret.txt"), "no");
    await symlink(join(dir, "secret.txt"), join(dir, "inner", "link.txt"));
    await expect(readInside(join(dir, "inner"), "../secret.txt")).rejects.toThrow("outside");
    await expect(readInside(join(dir, "inner"), "link.txt")).rejects.toThrow("outside");
  });
});

describe("agent profiles", () => {
  it("runs Claude Code with no setting sources and read tools", async () => {
    const plan = await planLaunch({ agent: "claude", model: "opus" }, "read", await tempDir());
    expect(plan.command).toEqual(["npx", "-y", ADAPTERS.claude]);
    expect(plan.sessionMeta).toEqual({
      claudeCode: { options: { settingSources: [], tools: ["Read", "Grep", "Glob"] } },
    });
    expect(plan.clean).toBe(true);
    const exec = await planLaunch({ agent: "claude" }, "exec", await tempDir());
    expect(exec.sessionMeta).toEqual({
      claudeCode: { options: { settingSources: [], tools: ["Read", "Grep", "Glob", "Bash"] } },
    });
  });

  it("runs Codex read-only and records that it is not clean", async () => {
    const plan = await planLaunch({ agent: "codex" }, "read", await tempDir());
    expect(plan.configOptions).toEqual({ mode: "read-only" });
    expect(plan.clean).toBe(false);
    expect((await planLaunch({ agent: "codex" }, "exec", await tempDir())).configOptions).toEqual({
      mode: "workspace-write",
    });
  });

  it("runs Pi through a clean wrapper", async () => {
    const dir = await tempDir();
    const plan = await planLaunch({ agent: "pi" }, "read", dir);
    const wrapper = join(dir, "pi-clean.sh");
    expect(plan.env).toEqual({ PI_ACP_PI_COMMAND: wrapper });
    await access(wrapper, constants.X_OK);
    expect(await readFile(wrapper, "utf8")).toContain("--no-extensions --no-skills --no-context-files");
    expect(await readFile(wrapper, "utf8")).toContain("--tools read,grep,find,ls ");
  });

  it("loads only the Pi extensions a member names", async () => {
    const dir = await tempDir();
    const plan = await planLaunch({ agent: "pi", extensions: ["~/ext/it's.ts", "/abs/b.ts"] }, "exec", dir);
    const wrapper = await readFile(join(dir, "pi-clean.sh"), "utf8");
    expect(wrapper).toContain(`--no-extensions -e '${join(homedir(), "ext", "it'\\''s.ts")}' -e '/abs/b.ts'`);
    expect(wrapper).toContain("--tools read,grep,find,ls,bash ");
    expect(plan.cleanNote).toContain("only these extensions");
  });

  it("allows Codex to read with commands, since its sandbox is read-only", async () => {
    expect((await planLaunch({ agent: "codex" }, "read", await tempDir())).allowKinds).toEqual(["execute"]);
    expect((await planLaunch({ agent: "claude" }, "read", await tempDir())).allowKinds).toEqual([]);
  });

  it("keeps a custom command, and lets a member pin another adapter", async () => {
    const custom = await planLaunch({ command: ["node", "agent.js"] }, "read", await tempDir());
    expect(custom).toMatchObject({ agent: null, command: ["node", "agent.js"], clean: null });
    const pinned = await planLaunch({ agent: "codex", command: ["npx", "-y", "x@1"] }, "read", await tempDir());
    expect(pinned).toMatchObject({ agent: "codex", command: ["npx", "-y", "x@1"], clean: false });
  });
});

describe("files", () => {
  it("hashes paths and contents, and copies folders", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c.txt"), "one");
    const first = await hashFolder(dir);
    expect(await hashFolder(dir)).toBe(first);
    const copy = `${dir}-copy`;
    await copyFolder(dir, copy);
    expect(await hashFolder(copy)).toBe(first);
    await writeFile(join(dir, "a", "b", "c.txt"), "two");
    expect(await hashFolder(dir)).not.toBe(first);
  });

  it("finds what looks like a key, without the value", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "clean.txt"), "nothing here");
    await writeFile(join(dir, "dirty.txt"), `token ${"hf_" + "a".repeat(34)}`);
    expect(await scanForKeys(dir)).toEqual([{ file: "dirty.txt", kind: "Hugging Face token" }]);
  });
});
