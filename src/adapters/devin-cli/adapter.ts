/**
 * Devin CLI adapter: one ACP session per turn over stdio.
 *
 * This is the local half of Devin support. The cloud-direct `devin` adapter
 * talks to Cognition's api-server; this one drives the installed `devin` CLI,
 * which carries its own credentials from `devin auth login`, so the proxy never
 * sees a token for this provider.
 *
 * runTurn-only, like the Cursor and cloud Devin adapters: a JSON-RPC handshake
 * over a child process has no fetch-shaped request to hand to the generic wire
 * path.
 */
import { spawn } from "node:child_process";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import {
  ACP_INITIALIZE_ID,
  ACP_SESSION_NEW_ID,
  ACP_SESSION_PROMPT_ID,
  MAX_ACP_LINE_BYTES,
  MAX_ACP_TOTAL_BYTES,
  acpUpdateToEvents,
  buildAcpPrompt,
  initializeFrame,
  mapAcpStopReason,
  mapAcpUsage,
  permissionResponseFrame,
  sessionNewFrame,
  sessionPromptFrame,
} from "./acp";
import { DEVIN_CLI_INSTALL_HINT, resolveDevinCliBinary } from "./binary";

/** A turn that produces nothing for this long is abandoned. */
const DEVIN_CLI_TURN_TIMEOUT_MS = 10 * 60 * 1000;

export function createDevinCliAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "devin-cli",

    buildRequest() {
      return { url: provider.baseUrl || "devin://acp/stdio", method: "POST", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Devin CLI adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Devin CLI turn was aborted before start." });
        return;
      }
      const binary = resolveDevinCliBinary();
      if (!binary) {
        emit({ type: "error", message: `Devin CLI not found. ${DEVIN_CLI_INSTALL_HINT}` });
        return;
      }

      const modelId = parsed.modelId.includes("/")
        ? parsed.modelId.slice(parsed.modelId.lastIndexOf("/") + 1)
        : parsed.modelId;
      const cwd = process.env.OPENCODEX_DEVIN_CLI_CWD?.trim() || process.cwd();

      await new Promise<void>((resolve) => {
        const child = spawn(binary, ["acp"], {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            ...process.env,
            // Headless: nobody can answer an interactive approval, and the
            // protocol-level auto-answer below only covers requests the agent
            // actually routes through session/request_permission.
            DEVIN_PERMISSION_MODE: process.env.DEVIN_PERMISSION_MODE ?? "bypass",
          },
        });

        let settled = false;
        let buffer = "";
        let totalBytes = 0;
        let openToolId: string | undefined;
        let usage: OcxUsage | undefined;
        let stopReason: string | undefined;

        const timer = setTimeout(() => finish(`Devin CLI turn exceeded ${DEVIN_CLI_TURN_TIMEOUT_MS}ms`), DEVIN_CLI_TURN_TIMEOUT_MS);
        const onAbort = () => finish("Devin CLI turn was aborted.");

        const closeOpenTool = () => {
          if (!openToolId) return;
          emit({ type: "tool_call_end" });
          openToolId = undefined;
        };

        function cleanup(): void {
          clearTimeout(timer);
          incoming.abortSignal?.removeEventListener("abort", onAbort);
          if (!child.killed) child.kill();
        }

        /** Terminate the turn exactly once, with an error when given a reason. */
        function finish(errorMessage?: string): void {
          if (settled) return;
          settled = true;
          cleanup();
          closeOpenTool();
          if (errorMessage) emit({ type: "error", message: errorMessage, ...(usage ? { usage } : {}) });
          else emit({ type: "done", ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}) });
          resolve();
        }

        incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });

        const send = (frame: Record<string, unknown>): void => {
          if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`);
        };

        child.on("error", (err) => finish(`Devin CLI failed to start (${binary}): ${err.message}. ${DEVIN_CLI_INSTALL_HINT}`));
        // A clean exit before the prompt reply means the agent ended the turn
        // without answering; whatever text arrived is still the turn's output.
        child.on("close", () => finish());

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          totalBytes += Buffer.byteLength(chunk, "utf8");
          if (totalBytes > MAX_ACP_TOTAL_BYTES) return finish("Devin CLI produced more output than one turn may consume.");
          buffer += chunk;
          if (buffer.length > MAX_ACP_LINE_BYTES) return finish("Devin CLI emitted a single line larger than the frame cap.");
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let frame: Record<string, unknown>;
            try {
              frame = JSON.parse(line) as Record<string, unknown>;
            } catch {
              // The CLI prints a banner before the protocol starts; a
              // non-JSON line is noise, not a protocol violation.
              continue;
            }
            handle(frame);
          }
        });

        function handle(frame: Record<string, unknown>): void {
          if (frame.id === ACP_INITIALIZE_ID && frame.result) {
            send(sessionNewFrame(cwd, modelId));
            return;
          }
          if (frame.id === ACP_SESSION_NEW_ID) {
            const error = frame.error as { message?: string } | undefined;
            if (error) return finish(`Devin CLI session/new failed: ${error.message ?? "unknown error"}`);
            const sessionId = (frame.result as { sessionId?: string } | undefined)?.sessionId;
            if (!sessionId) return finish("Devin CLI session/new returned no sessionId.");
            send(sessionPromptFrame(sessionId, buildAcpPrompt(parsed)));
            return;
          }
          if (frame.method === "session/request_permission" && frame.id != null) {
            const params = frame.params as { options?: Array<{ optionId?: string; name?: string; kind?: string }> } | undefined;
            send(permissionResponseFrame(frame.id as number | string, params?.options));
            return;
          }
          if (frame.method === "session/update") {
            const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update;
            if (!update) return;
            for (const event of acpUpdateToEvents(update)) {
              if (event.type === "tool_call_start") openToolId = event.id;
              if (event.type === "tool_call_end") openToolId = undefined;
              if (event.type === "text_delta" || event.type === "thinking_delta") closeOpenTool();
              emit(event);
            }
            return;
          }
          if (frame.id === ACP_SESSION_PROMPT_ID) {
            const error = frame.error as { message?: string } | undefined;
            if (error) return finish(`Devin CLI session/prompt failed: ${error.message ?? "unknown error"}`);
            const result = frame.result as { stopReason?: unknown; usage?: unknown } | undefined;
            usage = mapAcpUsage(result?.usage) ?? usage;
            stopReason = mapAcpStopReason(result?.stopReason);
            finish();
          }
        }

        send(initializeFrame(process.env.OPENCODEX_VERSION ?? "0.0.0"));
      });
    },
  };
}
