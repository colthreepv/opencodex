import { describe, expect, test } from "bun:test";
import { estimateAttemptCost } from "../../src/usage/cost";
import { findPriorityPricingRule, type ExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { OcxUsage, ProviderPromptPricing } from "../../src/types";

const BASE = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
const CUSTOM: ProviderPromptPricing = { policy: "custom", threshold: 1000, comparison: "gt", input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 };
const PRIORITY = { responseServiceTier: "priority" } as const;

function row(provider: string, modelId: string, promptPricing?: ProviderPromptPricing): ExpectedPriceOverlay {
  return {
    provider, modelId, cost4: BASE, source: "test", verifiedAt: "test", status: "verified",
    ...(promptPricing ? { promptPricing } : {}),
  };
}

function estimate(provider: string, model: string, usage: Partial<OcxUsage>, promptPricing?: ProviderPromptPricing, serviceTier?: typeof PRIORITY) {
  return estimateAttemptCost(
    {
      ordinal: 1,
      provider,
      model,
      usageStatus: "reported",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...usage } as OcxUsage,
    },
    [],
    serviceTier,
    [row(provider, model, promptPricing)],
  );
}

describe("attempt-level estimates honor promptPricing like request-level estimates", () => {
  test("raw prompt tokens including cache choose the custom band, and the whole attempt is repriced", () => {
    const result = estimate("attempt-price", "m", { inputTokens: 1200, cacheReadInputTokens: 900 }, CUSTOM)!;
    expect(result.contextTier).toBe("long");
    expect(result.cost.input).toBeCloseTo(300 * CUSTOM.input! / 1_000_000, 9);
    expect(result.cost.cacheRead).toBeCloseTo(900 * CUSTOM.cacheRead! / 1_000_000, 9);
  });

  test("output tokens never choose the band", () => {
    const result = estimate("attempt-price", "m", { inputTokens: 500, outputTokens: 5000 }, CUSTOM)!;
    expect(result.contextTier).toBeUndefined();
    expect(result.cost.input).toBeCloseTo(500 * BASE.input / 1_000_000, 9);
  });

  test("an absent policy keeps the automatic multiplier on the attempt path", () => {
    const result = estimate("openai", "gpt-5.6-sol", { inputTokens: 300_000 })!;
    expect(result.contextTier).toBe("long");
    expect(result.cost.input).toBeCloseTo(300_000 * BASE.input * 2 / 1_000_000, 9);
  });

  test("flat disables the automatic band on the attempt path and keeps the base rate", () => {
    const result = estimate("openai", "gpt-5.6-sol", { inputTokens: 300_000 }, { policy: "flat" })!;
    expect(result.contextTier).toBeUndefined();
    expect(result.cost.input).toBeCloseTo(300_000 * BASE.input / 1_000_000, 9);
  });

  test("stack: a custom band on a confirmed priority attempt multiplies by the provider priority rule", () => {
    const mult = findPriorityPricingRule("openai", "gpt-5.6-sol")!.multiplier;
    const result = estimate("openai", "gpt-5.6-sol", { inputTokens: 300_000 }, CUSTOM, PRIORITY)!;
    expect(result.priorityMultiplier).toBe(mult);
    expect(result.cost.input).toBeCloseTo(300_000 * CUSTOM.input! * mult / 1_000_000, 9);
  });

  test("lower-bound: a custom band on a confirmed priority attempt is flagged and gets no multiplier", () => {
    const result = estimate("xai", "grok-4.6", { inputTokens: 300_000 }, CUSTOM, PRIORITY)!;
    expect(result.priorityLowerBound).toBe(true);
    expect(result.priorityMultiplier).toBeUndefined();
    expect(result.cost.input).toBeCloseTo(300_000 * CUSTOM.input! / 1_000_000, 9);
  });

  test("unknown relation: a custom band keeps the response-confirmed provider priority multiplier", () => {
    const mult = findPriorityPricingRule("anthropic", "claude-opus-5-5")!.multiplier;
    const result = estimate("anthropic", "claude-opus-5-5", { inputTokens: 300_000 }, CUSTOM, PRIORITY)!;
    expect(result.priorityMultiplier).toBe(mult);
    expect(result.cost.input).toBeCloseTo(300_000 * CUSTOM.input! * mult / 1_000_000, 9);
  });
});
