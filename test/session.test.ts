import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planLaunch } from "../src/agents/registry.ts";
import { compileVoteSchema } from "../src/domain/vote.ts";
import { castVote } from "../src/run/turn.ts";
import type { SessionBudget } from "../src/acp/budget.ts";
import { AcpSession, type SessionSpec } from "../src/acp/session.ts";
import type { MemberConfig } from "../src/config/schema.ts";
import { fakeMember, folderWith, readLog, tempDir, type FakeScript } from "./helpers.ts";

type Opened = { member: AcpSession; log: string; events: Record<string, unknown>[]; stderr: string[] };

async function open(
  script: FakeScript,
  extra: Partial<MemberConfig> = {},
  model?: string,
  limits?: SessionBudget,
): Promise<Opened> {
  const dir = await tempDir();
  const workDir = await folderWith(dir, { "a.txt": "alpha" });
  await writeFile(join(dir, "outside.txt"), "secret");
  const { config, log } = await fakeMember(dir, "m", script, extra);
  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const spec: SessionSpec = {
    label: "member:A",
    plan: await planLaunch(config, "read", dir),
    model,
    options: config.options ?? {},
    workDir,
    permissions: "read",
    startTimeoutMs: 20_000,
    ...(limits ? { budget: { path: join(dir, "budget.json"), limits } } : {}),
  };
  const member = await AcpSession.open(spec, {
    onEvent: (event) => events.push(event),
    onStderr: (chunk) => stderr.push(chunk),
  });
  return { member, log, events, stderr };
}

describe("AcpSession", () => {
  it("saves partial text and stops after two submission attempts", async () => {
    const limits = { workSec: 30, submissionSec: 150, finalSec: 150, maxTokens: 1000, maxOutputTokens: 1000 };
    const { member, log } = await open(
      { rounds: { "1": { reply: "Partial finding without a vote", totalTokens: 12 } } },
      {},
      undefined,
      limits,
    );
    try {
      const result = await castVote(member, "## Round 1", {
        label: "member:A",
        round: 1,
        openItems: ["a"],
        schema: compileVoteSchema(),
        timeoutMs: 30000,
      });
      expect(result.status).toBe("no_result");
      expect(result.attempts).toHaveLength(3);
      expect(result.body).toContain("Partial finding");
      expect(result.attempts[0]?.usage?.totalTokens).toBe(12);
      expect((await readLog(log)).filter((entry) => typeof entry["prompt"] === "string")).toHaveLength(3);
      expect(member.budget?.phase()).toBe("stopped");
    } finally {
      await member.close();
    }
  });

  it("does not retry an adapter that crashed during a bounded vote", async () => {
    const { member } = await open({ rounds: { "1": { crash: true } } }, {}, undefined, {
      workSec: 30,
      submissionSec: 150,
      finalSec: 150,
      maxTokens: 1000,
      maxOutputTokens: 1000,
    });
    try {
      const result = await castVote(member, "## Round 1", {
        label: "member:A",
        round: 1,
        openItems: ["a"],
        schema: compileVoteSchema(),
        timeoutMs: 30000,
      });
      expect(result.status).toBe("no_result");
      expect(result.attempts).toHaveLength(1);
    } finally {
      await member.close();
    }
  });

  it("denies investigation reads during submission", async () => {
    const { member, log } = await open(
      { rounds: { "1": { permission: "read", readFile: "a.txt", reply: "partial" } } },
      {},
      undefined,
      { workSec: 30, submissionSec: 150, finalSec: 150, maxTokens: 1000, maxOutputTokens: 1000 },
    );
    try {
      member.budget?.advance();
      await member.prompt("submit", 10000);
      const entries = await readLog(log);
      expect(entries).toContainEqual({ permission: "read", outcome: { outcome: "cancelled" } });
      expect(entries.find((entry) => entry["readFile"] === "a.txt")?.["error"]).toBeDefined();
    } finally {
      await member.close();
    }
  });

  it("sends a timed reminder and ends both submission periods without resetting the clock", async () => {
    const { member, log } = await open({ rounds: { "1": { reply: "late", delayMs: 10000 } } }, {}, undefined, {
      workSec: 2,
      submissionSec: 0.2,
      finalSec: 0.2,
      maxTokens: 1000,
      maxOutputTokens: 1000,
    });
    try {
      const result = await castVote(member, "## Round 1", {
        label: "member:A",
        round: 1,
        openItems: ["a"],
        schema: compileVoteSchema(),
        timeoutMs: 30000,
      });
      expect(result.status).toBe("no_result");
      expect(member.budget?.phase()).toBe("stopped");
      const entries = await readLog(log);
      expect(entries.some((entry) => String(entry["prompt"]).startsWith("Time reminder:"))).toBe(true);
      expect(result.attempts.length).toBeLessThanOrEqual(4);
    } finally {
      await member.close();
    }
  });

  it("opens a session, sets the model and options, and collects the reply", async () => {
    const { member, log, events } = await open(
      { models: ["small", "large"], rounds: { "1": { reply: "hello world", totalTokens: 12 } } },
      { options: { mode: "Workspace" } },
      "large",
    );
    expect(member.info).toMatchObject({
      agentName: "fake-agent",
      agentVersion: "1.0.0",
      options: [
        { configId: "model", requested: "large", value: "large", name: "Fake large" },
        { configId: "mode", requested: "Workspace", value: "workspace-write", name: "Workspace" },
      ],
    });
    const outcome = await member.prompt("## Round 1", 10_000);
    expect(outcome).toMatchObject({ status: "done", text: "hello world", stopReason: "end_turn", error: null });
    expect(outcome.usage?.totalTokens).toBe(12);
    expect(events.filter((e) => e["type"] === "session/update")).toHaveLength(2);
    expect(await readLog(log)).toContainEqual({ setConfigOption: { model: "large" } });
    await member.close();
    expect(member.alive).toBe(false);
    await member.close();
  });

  it("cancels a turn past its time limit", async () => {
    const { member } = await open({ rounds: { "1": { reply: "late", delayMs: 5_000 } } });
    const outcome = await member.prompt("## Round 1", 200);
    expect(outcome.status).toBe("timeout");
    expect(outcome.text).toBe("");
    expect(member.alive).toBe(true);
    await member.close();
  });

  it("reports a crashed adapter as an error", async () => {
    const { member } = await open({ rounds: { "1": { crash: true } } });
    const outcome = await member.prompt("## Round 1", 10_000);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("exited");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(member.alive).toBe(false);
    await member.close();
  });

  it("denies edits, allows reads, and keeps file access inside the folder", async () => {
    const { member, log, events } = await open({
      rounds: {
        "1": { permission: "edit", reply: "x" },
        "2": { permission: "read", readFile: "a.txt", reply: "y" },
        "3": { readFile: "../outside.txt", writeFile: "a.txt", reply: "z" },
      },
    });
    await member.prompt("## Round 1", 10_000);
    await member.prompt("## Round 2", 10_000);
    await member.prompt("## Round 3", 10_000);
    await member.close();
    const entries = await readLog(log);
    expect(entries).toContainEqual({ permission: "edit", outcome: { outcome: "selected", optionId: "no" } });
    expect(entries).toContainEqual({ permission: "read", outcome: { outcome: "selected", optionId: "yes" } });
    expect(entries).toContainEqual({ readFile: "a.txt", content: "alpha" });
    expect(entries.find((e) => e["readFile"] === "../outside.txt")?.["error"]).toBeDefined();
    expect(entries.find((e) => e["writeFile"] === "a.txt")?.["error"]).toBeDefined();
    expect(events).toContainEqual(expect.objectContaining({ type: "write_denied" }));
  });

  it("records a model ID that the agent resolves to one of its values", async () => {
    const { member } = await open({ models: ["small", "large"], aliases: { "large-2-0": "large" } }, {}, "large-2-0");
    expect(member.info.options).toEqual([
      { configId: "model", requested: "large-2-0", value: "large", name: "Fake large" },
    ]);
    await member.close();
  });

  it("fails to open when the agent refuses the model or the session fails", async () => {
    const refused = open({ models: ["small"] }, {}, "huge");
    await expect(refused).rejects.toThrow("the agent refused huge for model");
    await expect(refused).rejects.toThrow("it offers: small (Fake small)");
    await expect(open({ failSessionNew: true })).rejects.toThrow("could not start");
    const crashed = open({ models: ["small"], crashOnSetConfig: true }, {}, "small");
    await expect(crashed).rejects.toThrow("could not start");
    await expect(crashed).rejects.not.toThrow("refused");
  });

  it("fails to open a command that does not exist or is empty", async () => {
    await expect(open({}, { command: ["/nonexistent/adapter"] })).rejects.toThrow("could not start");
    const dir = await tempDir();
    const spec: SessionSpec = {
      label: "member:A",
      plan: { ...(await planLaunch({ command: ["x"] }, "read", dir)), command: [] },
      model: undefined,
      options: {},
      workDir: dir,
      permissions: "read",
      startTimeoutMs: 1000,
    };
    await expect(AcpSession.open(spec, { onEvent: () => undefined, onStderr: () => undefined })).rejects.toThrow(
      "the adapter command is empty",
    );
  });
});
