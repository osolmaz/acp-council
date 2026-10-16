import * as acp from "@agentclientprotocol/sdk";
import type { Permissions } from "../agents/profile.ts";
import { readInside } from "./filesystem.ts";
import { choosePermission } from "./permissions.ts";

export type ClientHooks = {
  onEvent: (event: Record<string, unknown>) => void;
};

export type ClientPolicy = {
  workDir: string;
  permissions: Permissions;
  allowKinds: acp.ToolKind[];
};

/** The text that the agent sends during the current turn. */
export class Transcript {
  private chunks: string[] = [];

  reset(): void {
    this.chunks = [];
  }

  add(text: string): void {
    this.chunks.push(text);
  }

  text(): string {
    return this.chunks.join("");
  }
}

/**
 * The client side of the protocol: it answers permission requests with the policy, serves reads inside the member's
 * folder, refuses writes, records every session update, and collects the agent's text into the transcript.
 */
export function clientApp(policy: ClientPolicy, hooks: ClientHooks, transcript: Transcript): acp.ClientApp {
  return acp
    .client({ name: "acp-jury" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const response = choosePermission(ctx.params, policy.permissions, policy.allowKinds);
      hooks.onEvent({
        type: "permission",
        toolCall: ctx.params.toolCall,
        options: ctx.params.options,
        outcome: response.outcome,
      });
      return response;
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
      content: await readInside(policy.workDir, ctx.params.path, ctx.params.line, ctx.params.limit),
    }))
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
      hooks.onEvent({ type: "write_denied", path: ctx.params.path });
      throw new Error("acp-jury members cannot write files");
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      hooks.onEvent({ type: "session/update", update });
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        transcript.add(update.content.text);
      }
    });
}
