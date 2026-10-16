/**
 * A scripted ACP agent for tests. Run it with Node: `node test/fake-agent.ts <script.json> [<log file>]`.
 * It answers each prompt from the script entry for the prompt's round (`## Round N`), or from `nudge`
 * when the prompt is a nudge. It logs every prompt it gets to the log file, one JSON line per prompt.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type Entry = {
  reply?: string;
  delayMs?: number;
  crash?: boolean;
  permission?: acp.ToolKind;
  readFile?: string;
  writeFile?: string;
  totalTokens?: number;
};

type Script = {
  models?: string[];
  /** Model IDs that the agent resolves to one of its listed values, as the Claude adapter does. */
  aliases?: Record<string, string>;
  rounds?: Record<string, Entry>;
  nudge?: Entry;
  failSessionNew?: boolean;
};

const [scriptPath, logPath] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath ?? "", "utf8")) as Script;
const models = script.models ?? ["fake-model"];
let cancelled = false;
const config: Record<string, string> = { model: models[0] ?? "fake-model", mode: "read-only" };

function log(entry: Record<string, unknown>): void {
  if (logPath !== undefined) {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
}

function configOptions(): acp.SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: config["model"] ?? "",
      options: models.map((value) => ({ value, name: `Fake ${value}` })),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: config["mode"] ?? "",
      options: [
        { value: "read-only", name: "Read-only" },
        { value: "workspace-write", name: "Workspace" },
      ],
    },
  ];
}

/** Accepts a listed value or a known alias, and refuses anything else, as a real adapter does. */
function resolveValue(configId: string, value: string): string {
  const option = configOptions().find((candidate) => candidate.id === configId);
  const listed = option?.type === "select" && option.options.some((entry) => "value" in entry && entry.value === value);
  const resolved = listed ? value : configId === "model" ? script.aliases?.[value] : undefined;
  if (resolved === undefined) {
    throw new Error(`unknown value ${value} for ${configId}`);
  }
  return resolved;
}

function entryFor(prompt: string): Entry {
  if (prompt.startsWith("Your vote block could not be used")) {
    return script.nudge ?? {};
  }
  const rounds = script.rounds ?? {};
  const round = /## Round (\d+)/.exec(prompt)?.[1] ?? "1";
  return rounds[round] ?? rounds["*"] ?? {};
}

function isCancelled(): boolean {
  return cancelled;
}

async function sleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function sideEffects(entry: Entry, client: acp.AgentContext, sessionId: string): Promise<void> {
  if (entry.permission !== undefined) {
    const response = await client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "t1", title: `fake ${entry.permission}`, kind: entry.permission },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    log({ permission: entry.permission, outcome: response.outcome });
  }
  if (entry.readFile !== undefined) {
    const result = await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: entry.readFile }).then(
      (r) => ({ content: r.content }),
      (error: unknown) => ({ error: String(error) }),
    );
    log({ readFile: entry.readFile, ...result });
  }
  if (entry.writeFile !== undefined) {
    const result = await client
      .request(acp.methods.client.fs.writeTextFile, { sessionId, path: entry.writeFile, content: "x" })
      .then(
        () => ({ written: true }),
        (error: unknown) => ({ error: String(error) }),
      );
    log({ writeFile: entry.writeFile, ...result });
  }
}

async function reply(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  const half = Math.floor(text.length / 2);
  for (const part of [text.slice(0, half), text.slice(half)]) {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } },
    });
  }
}

acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    log({ sessionNew: { cwd: ctx.params.cwd, meta: ctx.params._meta ?? null } });
    if (script.failSessionNew === true) {
      throw new Error("fake session/new failure");
    }
    return { sessionId: "fake-session", configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    if ("value" in ctx.params && typeof ctx.params.value === "string") {
      const value = resolveValue(ctx.params.configId, ctx.params.value);
      config[ctx.params.configId] = value;
      log({ setConfigOption: { [ctx.params.configId]: ctx.params.value } });
    }
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const text = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    log({ prompt: text });
    const entry = entryFor(text);
    if (entry.crash === true) {
      process.exit(3);
    }
    cancelled = false;
    await sideEffects(entry, ctx.client, ctx.params.sessionId);
    await sleep(entry.delayMs ?? 0);
    if (isCancelled()) {
      return { stopReason: "cancelled" };
    }
    await reply(ctx.client, ctx.params.sessionId, entry.reply ?? "");
    return {
      stopReason: "end_turn",
      ...(entry.totalTokens === undefined
        ? {}
        : { usage: { totalTokens: entry.totalTokens, inputTokens: entry.totalTokens, outputTokens: 0 } }),
    };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancelled = true;
  })
  .connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
  );
