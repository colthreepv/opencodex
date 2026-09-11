import { describe, expect, test } from "bun:test";
import {
  ACP_SESSION_NEW_ID,
  acpUpdateToEvents,
  buildAcpPrompt,
  initializeFrame,
  mapAcpStopReason,
  mapAcpUsage,
  permissionResponseFrame,
  sessionNewFrame,
  sessionPromptFrame,
} from "../../src/adapters/devin-cli/acp";
import { DEVIN_CLI_BIN_ENV, resolveDevinCliBinary } from "../../src/adapters/devin-cli/binary";
import { createDevinCliAdapter } from "../../src/adapters/devin-cli/adapter";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxParsedRequest } from "../../src/types";

describe("devin-cli registration", () => {
  test("is a local provider that stores no credential", () => {
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin-cli");
    expect(entry?.adapter).toBe("devin-cli");
    // The installed CLI carries its own credentials from `devin auth login`,
    // so the proxy must never ask for or hold a key for this provider.
    expect(entry?.authKind).toBe("local");
    expect(entry?.dashboardPreset).toBe(false);
    expect(createDevinCliAdapter({ adapter: "devin-cli", baseUrl: "devin://acp/stdio" }).name).toBe("devin-cli");
  });
});

describe("acp handshake frames", () => {
  test("initialize declares protocol 1 and session/new carries cwd", () => {
    expect(initializeFrame("1.2.3")).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "opencodex", version: "1.2.3" } },
    });
    const withModel = sessionNewFrame("/repo", "swe-2") as { id: number; params: Record<string, unknown> };
    expect(withModel.id).toBe(ACP_SESSION_NEW_ID);
    expect(withModel.params).toEqual({ cwd: "/repo", mcpServers: [], model: "swe-2" });
    // No model named means the CLI picks its own default, so the key is absent
    // rather than present and empty.
    expect((sessionNewFrame("/repo") as { params: Record<string, unknown> }).params).toEqual({ cwd: "/repo", mcpServers: [] });
    expect(sessionPromptFrame("s1", "hi")).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    });
  });

  test("a permission request is answered with an allow-shaped option", () => {
    const kindMatch = permissionResponseFrame(9, [
      { optionId: "no", name: "Reject", kind: "reject_once" },
      { optionId: "yes", name: "Approve", kind: "allow_once" },
    ]) as { result: { outcome: { optionId: string } } };
    // Positional guessing would have taken the reject here.
    expect(kindMatch.result.outcome.optionId).toBe("yes");
    const nameMatch = permissionResponseFrame(9, [{ optionId: "accept-all", name: "Accept" }]) as {
      result: { outcome: { optionId: string } };
    };
    expect(nameMatch.result.outcome.optionId).toBe("accept-all");
    const empty = permissionResponseFrame(9, undefined) as { result: { outcome: { optionId: string } } };
    expect(empty.result.outcome.optionId).toBe("allow");
  });
});

describe("acp prompt projection", () => {
  test("system, tool calls and tool results all survive the flattening", () => {
    const parsed = {
      modelId: "swe-2",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "looking" },
              { type: "toolCall", id: "c1", name: "lookup", arguments: { q: "x" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: "ok", isError: false, timestamp: 3 },
        ],
        tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const prompt = buildAcpPrompt(parsed);
    expect(prompt).toContain("[System]\nbe brief");
    expect(prompt).toContain("[User]\nhi");
    // ACP takes one string, so a dropped tool loop would lose the thread.
    expect(prompt).toContain("[call lookup id=c1]");
    expect(prompt).toContain('{"q":"x"}');
    expect(prompt).toContain("[result id=c1]");
    expect(buildAcpPrompt({ ...parsed, context: { ...parsed.context, systemPrompt: [], messages: [] } })).toBe("(empty)");
  });
});

describe("acp update mapping", () => {
  test("message and thought chunks map to their own channels", () => {
    expect(acpUpdateToEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } })).toEqual([
      { type: "text_delta", text: "a" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "agent_thought_chunk", content: "why" })).toEqual([
      { type: "thinking_delta", thinking: "why" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
  });

  test("tool lifecycle opens on tool_call and closes only on a terminal status", () => {
    expect(acpUpdateToEvents({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", rawInput: { path: "a" } })).toEqual([
      { type: "tool_call_start", id: "t1", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":"a"}' },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })).toEqual([]);
    expect(acpUpdateToEvents({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })).toEqual([
      { type: "tool_call_end" },
    ]);
    expect(acpUpdateToEvents({ sessionUpdate: "plan", entries: [] })).toEqual([]);
  });
});

describe("acp turn outcome", () => {
  test("a natural end carries no stopReason", () => {
    // The bridge reads any truthy stopReason as "this turn did not finish", so
    // reporting end_turn would cost every clean turn its final_answer phase.
    expect(mapAcpStopReason("end_turn")).toBeUndefined();
    expect(mapAcpStopReason(undefined)).toBeUndefined();
    expect(mapAcpStopReason("max_tokens")).toBe("max_tokens");
    expect(mapAcpStopReason("refusal")).toBe("refusal");
  });

  test("usage is reported only when the agent actually counted something", () => {
    expect(mapAcpUsage({ inputTokens: 10, outputTokens: 4 })).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(mapAcpUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 9 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 9,
    });
    expect(mapAcpUsage({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
    expect(mapAcpUsage(undefined)).toBeUndefined();
  });
});

describe("devin cli discovery", () => {
  test("the environment override wins over every install path", () => {
    const previous = process.env[DEVIN_CLI_BIN_ENV];
    process.env[DEVIN_CLI_BIN_ENV] = "/custom/devin";
    try {
      expect(resolveDevinCliBinary({ exists: () => true, home: "/home/u", useCache: false })).toBe("/custom/devin");
    } finally {
      if (previous === undefined) delete process.env[DEVIN_CLI_BIN_ENV];
      else process.env[DEVIN_CLI_BIN_ENV] = previous;
    }
  });

  test("known install paths are preferred over a shadowed PATH entry, and absence is undefined", () => {
    const previous = process.env[DEVIN_CLI_BIN_ENV];
    delete process.env[DEVIN_CLI_BIN_ENV];
    try {
      const only = (p: string) => p === "/home/u/.local/bin/devin";
      expect(resolveDevinCliBinary({ exists: only, home: "/home/u", useCache: false })).toBe("/home/u/.local/bin/devin");
      expect(resolveDevinCliBinary({ exists: () => false, home: "/home/u", useCache: false })).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env[DEVIN_CLI_BIN_ENV] = previous;
    }
  });
});
