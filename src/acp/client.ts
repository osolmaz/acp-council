import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LaunchPlan, Permissions } from "./agents.ts";
import { planOptions, type OptionChoice } from "./options.ts";
import { choosePermission, readInside } from "./policy.ts";
import { VERSION } from "../meta/version.ts";

export type MemberSpec = {
  label: string;
  plan: LaunchPlan;
  model: string | undefined;
  options: Record<string, string>;
  workDir: string;
  permissions: Permissions;
  startTimeoutMs: number;
};

export type MemberInfo = {
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number;
  options: OptionChoice[];
};

export type TurnStatus = "done" | "timeout" | "error";

export type TurnOutcome = {
  status: TurnStatus;
  text: string;
  stopReason: string | null;
  usage: acp.Usage | null;
  error: string | null;
  durationMs: number;
};

export type MemberHooks = {
  onEvent: (event: Record<string, unknown>) => void;
  onStderr: (chunk: string) => void;
};

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

const CANCEL_GRACE_MS = 15_000;
const KILL_GRACE_MS = 5_000;
const CRASH_GRACE_MS = 1_000;

function settle<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, ms);
  });
  const result = promise.then(
    (value): Settled<T> => ({ kind: "value", value }),
    (error: unknown): Settled<T> => ({ kind: "error", error }),
  );
  return Promise.race([result, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const result = await settle(promise, ms);
  if (result.kind === "value") {
    return result.value;
  }
  throw result.kind === "timeout" ? new Error(`${what} took longer than ${ms} ms`) : result.error;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function spawnAdapter(spec: MemberSpec, hooks: MemberHooks): Child {
  const [command, ...args] = spec.plan.command;
  if (command === undefined) {
    throw new Error(`member ${spec.label} has an empty command`);
  }
  const child = spawn(command, args, {
    cwd: spec.workDir,
    env: { ...process.env, ...spec.plan.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (chunk: Buffer) => {
    hooks.onStderr(chunk.toString("utf8"));
  });
  return child;
}

function killGroup(child: Child, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The process group has already exited.
  }
}

/** One member: an adapter process with one ACP session. */
export class MemberConnection {
  private readonly child: Child;
  private readonly connection: acp.ClientConnection;
  private readonly sessionId: string;
  private readonly chunks: string[];
  private readonly exit: Promise<string>;
  private exited = false;
  readonly info: MemberInfo;

  private constructor(
    child: Child,
    connection: acp.ClientConnection,
    session: { sessionId: string; info: MemberInfo },
    chunks: string[],
    exit: Promise<string>,
  ) {
    this.child = child;
    this.connection = connection;
    this.sessionId = session.sessionId;
    this.info = session.info;
    this.chunks = chunks;
    this.exit = exit;
    void exit.then(() => {
      this.exited = true;
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  static async open(spec: MemberSpec, hooks: MemberHooks): Promise<MemberConnection> {
    const chunks: string[] = [];
    const child = spawnAdapter(spec, hooks);
    const connection = clientApp(spec, hooks, chunks).connect(
      acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    );
    child.once("error", (error) => {
      connection.close(error);
    });
    const exit = new Promise<string>((resolve) => {
      child.once("exit", (code, signal) => {
        const description = `the adapter exited with code ${String(code)} and signal ${String(signal)}`;
        connection.close(new Error(description));
        resolve(description);
      });
    });
    try {
      return new MemberConnection(child, connection, await startSession(connection, spec), chunks, exit);
    } catch (error) {
      connection.close();
      killGroup(child, "SIGKILL");
      throw new Error(`member ${spec.label} could not start: ${message(error)}`, { cause: error });
    }
  }

  /** Sends one prompt and waits for the turn to end. A turn past its time limit is cancelled. */
  async prompt(text: string, timeoutMs: number): Promise<TurnOutcome> {
    const started = Date.now();
    this.chunks.length = 0;
    const request = this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    const result = await settle(request, timeoutMs);
    const base = { text: this.chunks.join(""), durationMs: Date.now() - started };
    if (result.kind === "value") {
      return {
        ...base,
        status: "done",
        stopReason: result.value.stopReason,
        usage: result.value.usage ?? null,
        error: null,
      };
    }
    if (result.kind === "error") {
      const exit = await settle(this.exit, CRASH_GRACE_MS);
      const error = exit.kind === "value" ? exit.value : message(result.error);
      return { ...base, status: "error", stopReason: null, usage: null, error };
    }
    await this.cancel(request);
    return {
      ...base,
      status: "timeout",
      stopReason: null,
      usage: null,
      error: `the turn took longer than ${timeoutMs} ms`,
    };
  }

  private async cancel(request: Promise<unknown>): Promise<void> {
    await this.connection.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch(() => undefined);
    const late = await settle(request, CANCEL_GRACE_MS);
    if (late.kind === "timeout") {
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.connection.close();
    if (this.exited) {
      return;
    }
    killGroup(this.child, "SIGTERM");
    if ((await settle(this.exit, KILL_GRACE_MS)).kind === "timeout") {
      killGroup(this.child, "SIGKILL");
      await this.exit;
    }
  }
}

function clientApp(spec: MemberSpec, hooks: MemberHooks, chunks: string[]): acp.ClientApp {
  return acp
    .client({ name: "acp-council" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const response = choosePermission(ctx.params, spec.permissions, spec.plan.allowKinds);
      hooks.onEvent({
        type: "permission",
        toolCall: ctx.params.toolCall,
        options: ctx.params.options,
        outcome: response.outcome,
      });
      return response;
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
      content: await readInside(spec.workDir, ctx.params.path, ctx.params.line, ctx.params.limit),
    }))
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
      hooks.onEvent({ type: "write_denied", path: ctx.params.path });
      throw new Error("acp-council members cannot write files");
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      hooks.onEvent({ type: "session/update", update: ctx.params.update });
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
}

async function startSession(
  connection: acp.ClientConnection,
  spec: MemberSpec,
): Promise<{ sessionId: string; info: MemberInfo }> {
  const init = await within(
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      clientInfo: { name: "acp-council", version: VERSION },
    }),
    spec.startTimeoutMs,
    "initialize",
  );
  const session = await within(
    connection.agent.request(acp.methods.agent.session.new, {
      cwd: spec.workDir,
      mcpServers: [],
      ...(spec.plan.sessionMeta === undefined ? {} : { _meta: spec.plan.sessionMeta }),
    }),
    spec.startTimeoutMs,
    "session/new",
  );
  const choices = planOptions(session.configOptions ?? [], spec.model, { ...spec.options, ...spec.plan.configOptions });
  for (const choice of choices) {
    await within(
      connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: choice.configId,
        value: choice.value,
      }),
      spec.startTimeoutMs,
      `session/set_config_option ${choice.configId}`,
    );
  }
  return {
    sessionId: session.sessionId,
    info: {
      agentName: init.agentInfo?.name ?? null,
      agentVersion: init.agentInfo?.version ?? null,
      protocolVersion: init.protocolVersion,
      options: choices,
    },
  };
}
