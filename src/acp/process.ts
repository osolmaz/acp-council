import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { settle } from "../util/async.ts";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

export type ProcessOptions = {
  cwd: string;
  env: Record<string, string>;
  onStderr: (chunk: string) => void;
};

const STOP_GRACE_MS = 5_000;

/**
 * An adapter process. It runs in its own process group, so that stopping it also stops the agent that the adapter
 * started, such as the Claude Code or Codex process.
 */
export class AgentProcess {
  private readonly child: Child;
  private running = true;
  /** Resolves with a description of how the process ended. */
  readonly exited: Promise<string>;

  private constructor(child: Child) {
    this.child = child;
    this.exited = new Promise<string>((resolve) => {
      const end = (description: string): void => {
        this.running = false;
        resolve(description);
      };
      child.once("exit", (code, signal) => {
        end(`the adapter exited with code ${String(code)} and signal ${String(signal)}`);
      });
      child.once("error", (error) => {
        end(`the adapter could not run: ${error.message}`);
      });
    });
  }

  static start(command: string[], options: ProcessOptions): AgentProcess {
    const [program, ...args] = command;
    if (program === undefined) {
      throw new Error("the adapter command is empty");
    }
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stderr.on("data", (chunk: Buffer) => {
      options.onStderr(chunk.toString("utf8"));
    });
    return new AgentProcess(child);
  }

  get alive(): boolean {
    return this.running;
  }

  /** The process's stdio as an ACP stream of newline-delimited JSON. */
  stream(): Stream {
    return ndJsonStream(
      Writable.toWeb(this.child.stdin),
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (this.child.pid !== undefined) {
        process.kill(-this.child.pid, signal);
      }
    } catch {
      // The process group has already exited.
    }
  }

  kill(): void {
    this.signal("SIGKILL");
  }

  /** Asks the process group to stop, and kills it when it does not stop in time. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.signal("SIGTERM");
    if ((await settle(this.exited, STOP_GRACE_MS)).kind === "timeout") {
      this.kill();
      await this.exited;
    }
  }
}
