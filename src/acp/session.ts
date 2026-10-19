import { Budget, type SessionBudget } from "./budget.ts";
import * as acp from "@agentclientprotocol/sdk";
import type { LaunchPlan, Permissions } from "../agents/profile.ts";
import { VERSION } from "../meta/version.ts";
import { errorMessage, settle, within } from "../util/async.ts";
import { clientApp, Transcript } from "./client-app.ts";
import { appliedChoice, describeValues, planOptions, type OptionChoice, type OptionRequest } from "./config-options.ts";
import { AgentProcess } from "./process.ts";

export type SessionSpec = {
  label: string;
  plan: LaunchPlan;
  model: string | undefined;
  options: Record<string, string>;
  workDir: string;
  permissions: Permissions;
  startTimeoutMs: number;
  budget?: { path: string; limits: SessionBudget };
};

export type SessionInfo = {
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number;
  options: OptionChoice[];
};

export type SessionHooks = {
  onEvent: (event: Record<string, unknown>) => void;
  onStderr: (chunk: string) => void;
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

const CANCEL_GRACE_MS = 15_000;
const CRASH_GRACE_MS = 1_000;

/** One ACP session with one member: its adapter process, the protocol connection and the session ID. */
export class AcpSession {
  private readonly process: AgentProcess;
  private readonly connection: acp.ClientConnection;
  private readonly sessionId: string;
  private readonly transcript: Transcript;
  readonly info: SessionInfo;
  readonly budget: Budget | undefined;
  private previousUsage = { tokens: 0, output: 0 };

  private constructor(
    process: AgentProcess,
    connection: acp.ClientConnection,
    started: { sessionId: string; info: SessionInfo },
    transcript: Transcript,
    budget?: Budget,
  ) {
    this.process = process;
    this.connection = connection;
    this.sessionId = started.sessionId;
    this.info = started.info;
    this.budget = budget;
    this.transcript = transcript;
  }

  /** Starts the adapter, initializes the protocol, opens a session in the member's folder and sets its options. */
  static async open(spec: SessionSpec, hooks: SessionHooks): Promise<AcpSession> {
    const budget = spec.budget ? new Budget(spec.budget.path, spec.budget.limits) : undefined;
    if (budgetUnavailable(budget)) throw new Error("member budget exhausted before startup");
    const process = AgentProcess.start(spec.plan.command, {
      cwd: spec.workDir,
      env: spec.plan.env,
      onStderr: hooks.onStderr,
    });
    const transcript = new Transcript();
    const policy = {
      workDir: spec.workDir,
      permissions: spec.permissions,
      allowKinds: spec.plan.allowKinds,
      canInvestigate: () => budget === undefined || budget.phase() === "work",
    };
    const connection = clientApp(policy, hooks, transcript).connect(process.stream());
    void process.exited.then((description) => {
      connection.close(new Error(description));
    });
    try {
      return new AcpSession(
        process,
        connection,
        await within(startSession(connection, spec), boundedTimeout(budget, spec.startTimeoutMs), "member startup"),
        transcript,
        budget,
      );
    } catch (error) {
      connection.close();
      process.kill();
      throw new Error(`member ${spec.label} could not start: ${errorMessage(error)}`, { cause: error });
    }
  }

  get alive(): boolean {
    return this.process.alive;
  }

  /** Sends one prompt and waits for the turn to end. A turn past its time limit is cancelled. */
  async prompt(text: string, timeoutMs: number): Promise<TurnOutcome> {
    const started = Date.now();
    if (budgetUnavailable(this.budget))
      return {
        status: "timeout",
        text: "",
        stopReason: null,
        usage: null,
        error: "member budget exhausted",
        durationMs: 0,
      };
    timeoutMs = boundedTimeout(this.budget, timeoutMs);
    this.transcript.reset();
    const request = this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    const result = await settle(request, timeoutMs);
    const base = { text: this.transcript.text(), durationMs: Date.now() - started };
    if (result.kind === "value") {
      const { stopReason, usage } = result.value;
      this.recordUsage(usage);
      return { ...base, status: "done", stopReason, usage: usage ?? null, error: null };
    }
    this.budget?.unknownUsage();
    if (result.kind === "error") {
      const exit = await settle(this.process.exited, CRASH_GRACE_MS);
      const error = exit.kind === "value" ? exit.value : errorMessage(result.error);
      return { ...base, status: "error", stopReason: null, usage: null, error };
    }
    await this.cancel(request);
    this.budget?.unknownUsage();
    return {
      ...base,
      text: this.transcript.text(),
      status: "timeout",
      stopReason: null,
      usage: null,
      error: `the turn took longer than ${timeoutMs} ms`,
    };
  }

  private recordUsage(usage: acp.Usage | null | undefined): void {
    if (!usage) {
      this.budget?.unknownUsage();
      return;
    }
    this.budget?.addUsage(
      Math.max(0, usage.totalTokens - this.previousUsage.tokens),
      Math.max(0, usage.outputTokens - this.previousUsage.output),
    );
    this.previousUsage = {
      tokens: Math.max(this.previousUsage.tokens, usage.totalTokens),
      output: Math.max(this.previousUsage.output, usage.outputTokens),
    };
  }

  /** Cancels the running turn. An agent that does not stop in time is stopped with its process. */
  private async cancel(request: Promise<unknown>): Promise<void> {
    await this.connection.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch(() => undefined);
    if ((await settle(request, CANCEL_GRACE_MS)).kind === "timeout") {
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.connection.close();
    await this.process.stop();
  }
}

async function startSession(
  connection: acp.ClientConnection,
  spec: SessionSpec,
): Promise<{ sessionId: string; info: SessionInfo }> {
  const init = await within(
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      clientInfo: { name: "acp-jury", version: VERSION },
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
  const choices = await applyOptions(connection, spec, session.sessionId, session.configOptions ?? []);
  const info = {
    agentName: init.agentInfo?.name ?? null,
    agentVersion: init.agentInfo?.version ?? null,
    protocolVersion: init.protocolVersion,
    options: choices,
  };
  return { sessionId: session.sessionId, info };
}

/**
 * Sets the member's model and options, and reads back what the agent reports. An agent that refuses a value, such
 * as an unknown model ID, fails the start with the values it offers.
 */
async function applyOptions(
  connection: acp.ClientConnection,
  spec: SessionSpec,
  sessionId: string,
  offered: acp.SessionConfigOption[],
): Promise<OptionChoice[]> {
  const choices: OptionChoice[] = [];
  for (const request of planOptions(offered, spec.model, { ...spec.options, ...spec.plan.configOptions })) {
    const response = await within(
      connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: request.configId,
        value: request.value,
      }),
      spec.startTimeoutMs,
      `session/set_config_option ${request.configId}`,
    ).catch((error: unknown) => {
      throw refusal(error, request, offered);
    });
    choices.push(appliedChoice(request, response.configOptions));
  }
  return choices;
}

/**
 * Explains a failed `session/set_config_option`. A protocol error from the agent is a refusal of the value, and
 * lists the offered values. A timeout or a closed connection is not a refusal, so it keeps its own message.
 */
function refusal(error: unknown, request: OptionRequest, offered: acp.SessionConfigOption[]): unknown {
  if (!(error instanceof acp.RequestError)) {
    return error;
  }
  const option = offered.find((candidate) => candidate.id === request.configId);
  const values = option === undefined ? "" : describeValues(option);
  const list = values === "" ? "" : `; it offers: ${values}`;
  return new Error(`the agent refused ${request.requested} for ${request.configId} (${errorMessage(error)})${list}`);
}

function budgetUnavailable(budget: Budget | undefined): boolean {
  return budget !== undefined && (budget.phase() === "stopped" || budget.exhausted());
}

function boundedTimeout(budget: Budget | undefined, timeout: number): number {
  return budget === undefined ? timeout : Math.min(timeout, budget.remaining(budget.phase()));
}
