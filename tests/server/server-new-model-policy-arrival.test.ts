import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { clearModelCache } from "../../src/codex/model-cache";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { createTestCaseLifecycle } from "../helpers/test-sandbox-cleanup";

const provider = "fixture-catalog";
const existing = ["model-a", "model-b"];
const arrival = "model-c";
const now = "2026-01-01T00:00:00Z";
let home: TempHome;
let lifecycle: ReturnType<typeof createTestCaseLifecycle>;

beforeEach(() => {
  home = createTempHome("ocx-model-arrival-");
  mkdirSync(home.codexHome, { recursive: true });
  lifecycle = createTestCaseLifecycle();
  clearModelCache(provider);
});

afterEach(async () => {
  try {
    await lifecycle.close();
  } finally {
    clearModelCache(provider);
    home.remove();
  }
});

const cases: Array<{
  name: string;
  global: "on" | "off";
  local?: "on" | "off";
  visible: boolean;
}> = [
  { name: "provider off overrides global on", global: "on", local: "off", visible: false },
  { name: "inherited global off", global: "off", visible: false },
  { name: "provider on overrides global off", global: "off", local: "on", visible: true },
  { name: "inherited global on", global: "on", visible: true },
];

// Intentionally asserts the intended contract, including the currently failing off cases.
// Discovery is triggered through the real HTTP route, never by calling policy reconciliation.
test.each(cases)("new arrival before catalog convergence: $name", policy => lifecycle.run(async () => {
  let ids = [...existing];
  const discoveries: string[][] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/models") {
      return new Response("Unexpected upstream request", { status: 404 });
    }
    discoveries.push([...ids]);
    return Response.json({ data: ids.map(id => ({ id })) });
  } });
  lifecycle.ownStop(() => upstream.stop(true));
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, models: [...existing],
      ...(policy.local === undefined ? {} : { newModelPolicy: policy.local }),
    } },
    disabledModels: [`${provider}/model-b`],
    modelDiscovery: { newModelPolicy: policy.global, knownModels: {
      [provider]: { ids: [...existing], removed: [], updatedAt: now },
    } },
  };
  saveConfig(config);
  expect(loadConfig().modelDiscovery?.knownModels?.[provider]?.ids).toEqual(existing);
  const { startServer } = await import("../../src/server");
  lifecycle.abort.signal.throwIfAborted();
  const server = startServer(0);
  lifecycle.ownStop(() => server.stop(true));
  const read = async () => {
    const response = await fetch(new URL("/v1/models", server.url), { signal: lifecycle.abort.signal });
    expect(response.status).toBe(200);
    return (await response.json() as { data: Array<{ id: string }> }).data
      .map(model => model.id).filter(id => id.startsWith(`${provider}/`)).sort();
  };
  expect(await read()).toEqual([`${provider}/model-a`]);
  expect(discoveries.at(-1)).toEqual(existing);
  const previousDiscoveries = discoveries.length;
  ids = [...existing, arrival];
  // Exercise a fresh discovery without waiting for the production cache TTL to expire.
  clearModelCache(provider);
  const after = await read();
  expect(discoveries.length).toBeGreaterThan(previousDiscoveries);
  expect(discoveries.at(-1)).toEqual([...existing, arrival]);
  expect(after).toContain(`${provider}/model-a`);
  expect(after).not.toContain(`${provider}/model-b`);
  expect(after).toEqual(policy.visible
    ? [`${provider}/model-a`, `${provider}/model-c`]
    : [`${provider}/model-a`]);
}), SERVER_BUDGET_MS);
