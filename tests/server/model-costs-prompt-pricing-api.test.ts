import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { saveConfigPreservingClaudeCode } from "../../src/config";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import type { OcxConfig, OcxUsage, ProviderCostOverlay } from "../../src/types";
import { estimateRequestCost } from "../../src/usage/cost";
import { activeUserCostOverlays, refreshUserCostOverlays, userCostOverlayVersion } from "../../src/usage/user-cost-overlays";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROVIDER = "prompt-price-api";
const MODEL = "org/long";
const RATES = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
const CUSTOM = { policy: "custom", threshold: 1000, comparison: "gt", input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 } as const;
const ROW: ProviderCostOverlay = { ...RATES, promptPricing: CUSTOM };
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function fixture(costs: Record<string, ProviderCostOverlay> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    modelCacheTtlMs: 60_000,
    providers: {
      [PROVIDER]: {
        adapter: "openai-chat",
        baseUrl: "https://prompt-price.example.invalid/v1",
        liveModels: false,
        models: [MODEL],
        modelCosts: costs,
      },
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-prompt-price-api-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
});

afterEach(() => {
  clearModelCache();
  resetCodexModelEntitlementCacheForTests();
  refreshUserCostOverlays(fixture());
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function harness(config: OcxConfig) {
  async function call(method: "GET" | "PUT", body?: unknown) {
    const url = new URL(`http://127.0.0.1:10100/api/providers/${PROVIDER}/model-costs`);
    const response = await handleModelRoutes({
      version: "test",
      req: new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
      }),
      url,
      config,
      deps: {
        saveConfigPreservingClaudeCode: saved => saveConfigPreservingClaudeCode(saved),
      },
      convergeCodexCatalog: async () => {
        throw new Error("price writes must not converge catalogs");
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    if (!response) throw new Error("model-costs route was not dispatched");
    return response;
  }
  return { call };
}

function diskConfig(): OcxConfig {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
}

function usage(inputTokens: number): OcxUsage {
  return { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } as OcxUsage;
}

function liveEstimate(inputTokens: number) {
  return estimateRequestCost(
    { provider: PROVIDER, model: MODEL, usage: usage(inputTokens), usageStatus: "reported" },
    undefined,
    activeUserCostOverlays(),
  )!;
}

describe("model-costs promptPricing over the management API", () => {
  test("PUT persists the nested policy, GET returns it, and the live overlay reprices the request", async () => {
    const config = fixture();
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config);

    const put = await h.call("PUT", { modelId: MODEL, cost: ROW });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { cost: unknown }).cost).toEqual(ROW);
    expect(diskConfig().providers[PROVIDER]!.modelCosts![MODEL]).toEqual(ROW);
    expect(await (await h.call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: { [MODEL]: ROW } });

    const estimate = liveEstimate(1500);
    expect(estimate.contextTier).toBe("long");
    expect(estimate.cost.input).toBeCloseTo(1500 * CUSTOM.input / 1_000_000, 9);
  });

  test("a policy-only edit bumps the overlay version and changes the live estimate", async () => {
    const config = fixture();
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config);
    await h.call("PUT", { modelId: MODEL, cost: ROW });
    expect(liveEstimate(800).contextTier).toBeUndefined();

    const before = userCostOverlayVersion();
    const tighter = { ...ROW, promptPricing: { ...CUSTOM, threshold: 500 } };
    expect((await h.call("PUT", { modelId: MODEL, cost: tighter })).status).toBe(200);
    const afterPolicy = userCostOverlayVersion();
    expect(afterPolicy).toBeGreaterThan(before);
    expect(liveEstimate(800).contextTier).toBe("long");
    expect(liveEstimate(800).cost.input).toBeCloseTo(800 * CUSTOM.input / 1_000_000, 9);

    // An identical save changes nothing the estimator reads, so the cache must survive it.
    expect((await h.call("PUT", { modelId: MODEL, cost: tighter })).status).toBe(200);
    expect(userCostOverlayVersion()).toBe(afterPolicy);
  });

  test("a rate-only PUT replaces the row and drops the stored policy", async () => {
    const config = fixture();
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config);
    await h.call("PUT", { modelId: MODEL, cost: ROW });
    expect((await h.call("PUT", { modelId: MODEL, cost: { ...RATES, promptPricing: { policy: "flat" } } })).status).toBe(200);
    expect(diskConfig().providers[PROVIDER]!.modelCosts![MODEL]).toEqual({ ...RATES, promptPricing: { policy: "flat" } });
    expect(liveEstimate(1500).contextTier).toBeUndefined();

    expect((await h.call("PUT", { modelId: MODEL, cost: RATES })).status).toBe(200);
    expect(Object.hasOwn(diskConfig().providers[PROVIDER]!.modelCosts![MODEL]!, "promptPricing")).toBe(false);
  });

  test("reset deletes the whole row, including its policy, from disk and the live registry", async () => {
    const config = fixture();
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config);
    await h.call("PUT", { modelId: MODEL, cost: ROW });
    expect((await h.call("PUT", { modelId: MODEL, cost: null })).status).toBe(200);
    expect(Object.keys(diskConfig().providers[PROVIDER]!.modelCosts ?? {})).toEqual([]);
    expect(await (await h.call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: {} });
    expect(activeUserCostOverlays().some(row => row.provider === PROVIDER && row.modelId === MODEL)).toBe(false);
  });

  test("an invalid nested policy is rejected before anything is written", async () => {
    const config = fixture();
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config);
    for (const promptPricing of [{ ...CUSTOM, threshold: 0 }, { ...CUSTOM, comparison: "ge" }, { policy: "flat", threshold: 1 }]) {
      expect((await h.call("PUT", { modelId: MODEL, cost: { ...RATES, promptPricing } })).status).toBe(400);
    }
    expect(Object.keys(diskConfig().providers[PROVIDER]!.modelCosts ?? {})).toEqual([]);
    expect(activeUserCostOverlays().some(row => row.provider === PROVIDER)).toBe(false);
  });
});
