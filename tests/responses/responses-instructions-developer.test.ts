import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { parseRequest } from "../../src/responses/parser";
import { CHECKPOINT_CONTINUATION_NOTE, SUMMARY_PREFIX } from "../../src/responses/compaction";
import { chatConversationToIr } from "../../src/protocols/codecs/chat-ir";
import { prepareCompactionRetention } from "../../src/server/responses/compaction-retention";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";

const instructions = "Keep the caller's instructions exactly.\nPreserve whitespace.  ";
const developer = { type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] };
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }];
const ingress = { instructionsAsDeveloper: true };

describe("Responses top-level instructions use the Codex developer path", () => {
  test("leading developer content has the same normalized representation and leaves raw native input untouched", () => {
    const raw = { model: "model", instructions, input: structuredClone(input) };
    const before = structuredClone(raw);
    const parsed = parseRequest(raw, ingress);
    expect(parsed.context.systemPrompt).toBeUndefined();
    expect(parsed.context.messages.map(({ timestamp, ...message }) => message)).toEqual([
      { role: "developer", content: instructions },
      { role: "user", content: "Hello" },
    ]);
    expect(parsed._rawBody).toBe(raw);
    expect(raw).toEqual(before);
    expect(parsed._instructionsAsDeveloper).toBe(true);
  });

  test.each([undefined, ""])("absent/empty instructions create no developer message (%j)", value => {
    expect(parseRequest({ model: "model", instructions: value, input }, ingress).context.messages).toHaveLength(1);
  });

  test("string input and previous-response boundary keep instructions before the conversation", () => {
    const parsed = parseRequest({ model: "model", instructions, input: "Hello", previous_response_id: "resp_previous" }, ingress);
    expect(parsed.context.messages.map(message => message.role)).toEqual(["developer", "user"]);
    expect(parsed._continuationConversationMessageIndex).toBe(1);
  });

  test("proxy-added checkpoint guidance stays system while caller instructions match developer input", () => {
    const history = [{ role: "user", content: "Earlier task" }, { role: "user", content: `${SUMMARY_PREFIX}\nCompleted earlier work` }, ...input];
    const fromInstructions = parseRequest({ model: "model", instructions, input: history }, ingress);
    const fromDeveloper = parseRequest({ model: "model", input: [developer, ...history] }, ingress);
    expect(fromInstructions.context.systemPrompt).toEqual([CHECKPOINT_CONTINUATION_NOTE]);
    expect(fromInstructions.context.messages[0]).toMatchObject({ role: "developer", content: instructions });
    const withoutTimes = (parsed: ReturnType<typeof parseRequest>) => parsed.context.messages.map(({ timestamp, ...message }) => message);
    expect(withoutTimes(fromInstructions)).toEqual(withoutTimes(fromDeveloper));
    expect(fromInstructions.context.systemPrompt).toEqual(fromDeveloper.context.systemPrompt);
  });

  test("explicit system input stays system; default internal parsing and direct Chat semantics are unchanged", () => {
    const raw = { model: "model", instructions, input: [{ type: "message", role: "system", content: "Explicit system" }, ...input] };
    expect(parseRequest(raw, ingress).context.systemPrompt).toEqual(["Explicit system"]);
    const internal = parseRequest(raw);
    expect(internal.context.systemPrompt).toEqual([instructions, "Explicit system"]);
    expect(internal.context.messages.map(message => message.role)).toEqual(["user"]);
    expect(internal._instructionsAsDeveloper).toBeUndefined();
    const chat = chatConversationToIr({ messages: [{ role: "system", content: instructions }, { role: "user", content: "Hello" }] }, "model");
    expect(chat.context.systemPrompt).toEqual([instructions.trim()]);
  });

  test.each(["key", "oauth"] as const)("Anthropic %s bodies exactly match equivalent Codex developer input, including cache/tools/thinking", async authMode => {
    const common = {
      model: "claude-opus-5-5", input, stream: true, reasoning: { effort: "medium" },
      tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    };
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode, apiKey: "fixture-only" }));
    const fromInstructions = await adapter.buildRequest(parseRequest({ ...common, instructions }, ingress));
    const fromDeveloper = await adapter.buildRequest(parseRequest({ ...common, input: [developer, ...input] }));
    expect(JSON.parse(fromInstructions.body)).toEqual(JSON.parse(fromDeveloper.body));
    const body = JSON.parse(fromInstructions.body);
    expect(body.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }] });
    expect(body.thinking.type).toBe("adaptive");
    expect(body.tools).toHaveLength(1);
    expect(JSON.stringify(body.system)).not.toContain(instructions);
  });

  test.each([false, true])("retention reparsing preserves instruction interpretation (developer=%s)", instructionsAsDeveloper => {
    const raw = { model: "model", instructions, input: [
      ...input, { type: "reasoning", summary: [{ type: "summary_text", text: "Private historical reasoning" }] },
      { type: "compaction_trigger" },
    ] };
    const parsed = parseRequest(raw, { instructionsAsDeveloper });
    const before = structuredClone(parsed.context.messages[0]);
    const config: OcxConfig = { port: 0, providers: {}, reasoningRetention: { enabled: true } };
    const retention = prepareCompactionRetention(parsed, config, undefined, createTestTranslatorBudget(), new AbortController().signal);
    try {
      expect(retention).toBeDefined();
      const { timestamp: _before, ...expected } = before;
      const { timestamp: _after, ...actual } = parsed.context.messages[0]!;
      expect(actual).toEqual(expected);
      expect(parsed.context.messages.filter(message => message.role === "developer")).toHaveLength(instructionsAsDeveloper ? 1 : 0);
      expect(parsed.context.systemPrompt).toEqual(instructionsAsDeveloper ? undefined : [instructions]);
    } finally { retention?.dispose(); }
  });
});

describe("actual Responses, Chat and Messages ingress", () => {
  test("only Responses normalizes instructions, and native Responses still forwards the raw field", async () => {
    const sent: Record<string, any>[] = [];
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      sent.push(await request.json() as Record<string, any>);
      if (request.url.endsWith("/responses")) return Response.json({ id: "resp_fixture", status: "completed", output: [] });
      if (sent.at(-1)!.stream) return new Response([
        { type: "message_start", message: { id: "msg_fixture", role: "assistant", model: "model", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "model", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    const release = acquireOwnedSpendHome();
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`, authMode: "key", apiKey: "fixture-only", allowPrivateNetwork: true, models: ["model"],
    } } };
    const request = (path: string, body: unknown) => new Request(`http://localhost/v1/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      const response = await handleResponses(request("responses", { model: "fixture/model", instructions, input }), config, { model: "", provider: "" });
      expect(await response.text()).toContain("Hello");
      expect(response.status).toBe(200);
      expect(sent[0]!.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: instructions }] });
      const chat = await handleChatCompletions(request("chat/completions", { model: "fixture/model", messages: [{ role: "system", content: instructions }, { role: "user", content: "Hello" }] }), config, { model: "", provider: "" });
      const chatText = await chat.text();
      expect({ status: chat.status, body: chatText }).toMatchObject({ status: 200 });
      expect(JSON.stringify(sent[1]!.system)).toContain("Keep the caller's instructions exactly.");
      expect(sent[1]!.messages).toHaveLength(1);
      const messages = await handleClaudeMessages(request("messages", { model: "fixture/model", max_tokens: 64, system: instructions, messages: [{ role: "user", content: "Hello" }] }), config, { model: "", provider: "" });
      const messagesText = await messages.text();
      expect({ status: messages.status, body: messagesText }).toMatchObject({ status: 200 });
      expect(JSON.stringify(sent[2]!.system)).toContain("Keep the caller's instructions exactly.");
      expect(sent[2]!.messages).toHaveLength(1);
      config.providers.fixture!.adapter = "openai-responses";
      const native = await handleResponses(request("responses", { model: "fixture/model", instructions, input }), config, { model: "", provider: "" });
      await native.text();
      expect(native.status).toBe(200);
      expect(sent[3]!.instructions).toBe(instructions);
      expect(sent[3]!.input).toEqual(input);
    } finally { release(); await upstream.stop(true); }
  });
});
