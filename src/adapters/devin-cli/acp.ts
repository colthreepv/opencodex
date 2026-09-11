/**
 * Agent Client Protocol framing for the Devin CLI.
 *
 * `devin acp` speaks newline-delimited JSON-RPC on stdin/stdout. One ACP session
 * answers one prompt, so a turn is: initialize -> session/new -> session/prompt,
 * with session/update notifications streaming in between and a unary reply to
 * the prompt carrying the stop reason and usage.
 *
 * This module is pure. It never spawns a process and never touches the network,
 * so the framing and the event mapping are testable against captured lines, the
 * same discipline src/adapters/coding-agent/protocol.ts follows for the
 * stream-json CLIs.
 */
import type { AdapterEvent, OcxParsedRequest, OcxToolCall, OcxUsage } from "../../types";

/** Hard ceiling on a single buffered stdout line. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on total stdout bytes consumed for one turn. */
export const MAX_ACP_TOTAL_BYTES = 64 * 1024 * 1024;

export class AcpProtocolError extends Error {
  readonly code = "protocol_error";
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export const ACP_INITIALIZE_ID = 1;
export const ACP_SESSION_NEW_ID = 2;
export const ACP_SESSION_PROMPT_ID = 3;

export function initializeFrame(clientVersion: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: ACP_INITIALIZE_ID,
    method: "initialize",
    params: { protocolVersion: 1, clientInfo: { name: "opencodex", version: clientVersion }, capabilities: {} },
  };
}

export function sessionNewFrame(cwd: string, modelId?: string): Record<string, unknown> {
  const params: Record<string, unknown> = { cwd, mcpServers: [] };
  // The CLI picks its own default when no model is named, which is what an
  // unset or vendor-default selection should do.
  if (modelId) params.model = modelId;
  return { jsonrpc: "2.0", id: ACP_SESSION_NEW_ID, method: "session/new", params };
}

export function sessionPromptFrame(sessionId: string, prompt: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: ACP_SESSION_PROMPT_ID,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: prompt }] },
  };
}

/**
 * Answer a permission request without a human.
 *
 * A headless turn has nobody to approve a tool call, and an unanswered
 * session/request_permission stalls the agent until the turn times out. Prefer
 * an explicitly allow-shaped option over positional guessing; fall back to the
 * first offered option only when none of them say so.
 */
export function permissionResponseFrame(
  id: number | string,
  options: Array<{ optionId?: string; name?: string; kind?: string }> | undefined,
): Record<string, unknown> {
  const list = options ?? [];
  const allow =
    list.find((o) => typeof o.kind === "string" && /^allow/i.test(o.kind)) ??
    list.find((o) => /allow|accept|yes/i.test(`${o.optionId ?? ""} ${o.name ?? ""}`)) ??
    list[0];
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow" } },
  };
}

/**
 * Flatten an OcxContext into the single prompt string one ACP session takes.
 *
 * ACP has no multi-message history on session/prompt, so the conversation is
 * projected into labelled blocks. Tool calls and results are rendered rather
 * than dropped, because a turn that omits them loses the thread of a tool loop.
 */
export function buildAcpPrompt(parsed: OcxParsedRequest): string {
  const blocks: string[] = [];
  const system = parsed.context.systemPrompt?.filter((line) => line.trim().length > 0).join("\n");
  if (system) blocks.push(`[System]\n${system}`);
  for (const message of parsed.context.messages) {
    if (message.role === "toolResult") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      blocks.push(`[Tool]\n[result id=${message.toolCallId}]\n${body}`);
      continue;
    }
    const parts = typeof message.content === "string" ? [] : message.content;
    let text = typeof message.content === "string"
      ? message.content
      : parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
    if (message.role === "assistant" && Array.isArray(parts)) {
      const calls = parts
        .filter((p): p is OcxToolCall => p.type === "toolCall")
        .map((c) => `[call ${c.name} id=${c.id}]\n${JSON.stringify(c.arguments ?? {})}`)
        .join("\n\n");
      if (calls) text = text ? `${text}\n\n${calls}` : calls;
    }
    if (!text.trim()) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "developer" ? "System" : "User";
    blocks.push(`[${label}]\n${text}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "(empty)";
}

export type AcpTurnOutcome = { stopReason?: string; usage?: OcxUsage };

/** ACP stop reasons that mean the turn ended normally. */
const NATURAL_STOP = new Set(["end_turn", "stop", "completed"]);

export function mapAcpStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || NATURAL_STOP.has(reason)) return undefined;
  if (reason === "max_tokens") return "max_tokens";
  return reason;
}

export function mapAcpUsage(raw: unknown): OcxUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = typeof u.inputTokens === "number" ? u.inputTokens : 0;
  const output = typeof u.outputTokens === "number" ? u.outputTokens : 0;
  if (input === 0 && output === 0) return undefined;
  const total = typeof u.totalTokens === "number" ? u.totalTokens : input + output;
  return { inputTokens: input, outputTokens: output, ...(total > 0 ? { totalTokens: total } : {}) };
}

function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Translate one session/update notification into adapter events.
 *
 * Tool lifecycle is explicit in ACP: `tool_call` opens one and
 * `tool_call_update` with a terminal status closes it, so the caller does not
 * have to infer boundaries from interleaving the way a delta-only wire forces.
 */
export function acpUpdateToEvents(update: Record<string, unknown>): AdapterEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "thinking_delta", thinking: text }] : [];
  }
  if (kind === "tool_call") {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const name = typeof update.title === "string" ? update.title : typeof update.kind === "string" ? update.kind : "tool";
    if (!id) return [];
    const events: AdapterEvent[] = [{ type: "tool_call_start", id, name }];
    if (update.rawInput !== undefined) {
      events.push({ type: "tool_call_delta", arguments: JSON.stringify(update.rawInput) });
    }
    return events;
  }
  if (kind === "tool_call_update") {
    const status = update.status;
    if (status === "completed" || status === "failed") return [{ type: "tool_call_end" }];
    return [];
  }
  return [];
}
