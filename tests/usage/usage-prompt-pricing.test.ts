import { describe, expect, test } from "bun:test";
import { applyPriorityMultiplier, applyPromptPricingBand, estimateRequestCost } from "../../src/usage/cost";
import {
  findContextTier,
  findPriorityPricingRule,
  type ContextTier,
  type ExpectedPriceOverlay,
} from "../../src/usage/expected-prices";
import { normalizePromptPricing, promptPricingConfigError, promptPricingCrossed } from "../../src/usage/prompt-pricing";
import type { OcxUsage, ProviderPromptPricing } from "../../src/types";

const BASE = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
const CUSTOM = {
  policy: "custom", threshold: 1000, comparison: "gt",
  input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75,
} as const;
const PRIORITY = { responseServiceTier: "priority" } as const;

function tierTable(relation: ContextTier["confirmedPriorityRelation"]): ContextTier[] {
  return [{
    provider: "p", modelId: "m", thresholdInputTokens: 1000, inclusive: false,
    multiplier: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
    ...(relation === undefined ? {} : { confirmedPriorityRelation: relation }),
    source: "test", verifiedAt: "2026-10-08",
  }];
}

function row(provider: string, modelId: string, promptPricing?: ProviderPromptPricing): ExpectedPriceOverlay {
  return {
    provider, modelId, cost4: BASE, source: "test", verifiedAt: "test", status: "verified",
    ...(promptPricing ? { promptPricing } : {}),
  };
}

function usage(inputTokens: number): OcxUsage {
  return { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } as OcxUsage;
}

function price(provider: string, model: string, rows: ExpectedPriceOverlay[], raw: number, serviceTier?: typeof PRIORITY) {
  return estimateRequestCost(
    { provider, model, usage: usage(raw), usageStatus: "reported", serviceTier },
    undefined,
    rows,
  );
}

describe("prompt-size policy validation", () => {
  test("absent and automatic are valid; flat accepts only its policy", () => {
    expect(promptPricingConfigError(undefined, "f")).toBeNull();
    expect(promptPricingConfigError({ policy: "automatic" }, "f")).toBeNull();
    expect(promptPricingConfigError({ policy: "flat" }, "f")).toBeNull();
    expect(promptPricingConfigError({ policy: "flat", threshold: 1 }, "f")).not.toBeNull();
  });

  test("custom needs a positive safe integer threshold, gt or gte, and four valid rates", () => {
    expect(promptPricingConfigError(CUSTOM, "f")).toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, comparison: "ge" }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, threshold: 0 }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, threshold: 1.5 }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, threshold: Number.MAX_SAFE_INTEGER + 2 }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, input: -1 }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, cacheWrite: undefined }, "f")).not.toBeNull();
    expect(promptPricingConfigError({ ...CUSTOM, apiKey: "x" }, "f")).not.toBeNull();
  });

  test("normalize drops automatic and invalid input, and copies a valid custom row", () => {
    expect(normalizePromptPricing({ policy: "automatic" })).toBeUndefined();
    expect(normalizePromptPricing({ ...CUSTOM, threshold: 0 })).toBeUndefined();
    expect(normalizePromptPricing(CUSTOM)).toEqual(CUSTOM);
  });

  test("gt and gte differ exactly at the threshold, and NaN never crosses", () => {
    expect(promptPricingCrossed({ ...CUSTOM, comparison: "gt" }, 1000)).toBe(false);
    expect(promptPricingCrossed({ ...CUSTOM, comparison: "gte" }, 1000)).toBe(true);
    expect(promptPricingCrossed(CUSTOM, Number.NaN)).toBe(false);
  });
});

describe("custom band interactions with the confirmed-priority relation", () => {
  test("exclusive keeps the base rate on confirmed priority, and bands an unconfirmed request", () => {
    const table = tierTable("exclusive");
    expect(applyPromptPricingBand(BASE, "p", "m", 2000, PRIORITY, CUSTOM, table))
      .toEqual([BASE, undefined, false, undefined]);
    const [cost4, tier, , source] = applyPromptPricingBand(BASE, "p", "m", 2000, undefined, CUSTOM, table);
    expect(cost4).toEqual({ input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(tier).toBe("long");
    expect(source).toBe("custom");
  });

  test("lower-bound applies the custom band and flags it under confirmed priority only", () => {
    const table = tierTable("lower-bound");
    const confirmed = applyPromptPricingBand(BASE, "p", "m", 2000, PRIORITY, CUSTOM, table);
    expect(confirmed[0]).toEqual({ input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(confirmed[2]).toBe(true);
    const unconfirmed = applyPromptPricingBand(BASE, "p", "m", 2000, undefined, CUSTOM, table);
    expect(unconfirmed[2]).toBe(false);
  });

  test("an unknown relation applies the custom band and keeps it on the standard-speed path", () => {
    const [cost4, tier, lower, source] = applyPromptPricingBand(BASE, "p", "m", 2000, PRIORITY, CUSTOM, []);
    expect(cost4).toEqual({ input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(tier).toBe("long");
    expect(lower).toBe(false);
    expect(source).toBe("custom");
  });

  test("flat disables the band and never flags a lower bound", () => {
    const [cost4, tier, lower, source] = applyPromptPricingBand(BASE, "p", "m", 2000, PRIORITY, { policy: "flat" }, tierTable("stack"));
    expect(cost4).toEqual(BASE);
    expect([tier, lower, source]).toEqual([undefined, false, undefined]);
  });
});

describe("custom rows against the published relations and priority rules", () => {
  test("stack: a custom band stacks the provider priority multiplier", () => {
    expect(findContextTier("openai", "gpt-5.6-sol")?.confirmedPriorityRelation).toBe("stack");
    const mult = findPriorityPricingRule("openai", "gpt-5.6-sol")!.multiplier;
    const estimate = price("openai", "gpt-5.6-sol", [row("openai", "gpt-5.6-sol", CUSTOM)], 300000, PRIORITY)!;
    expect(estimate.contextTier).toBe("long");
    expect(estimate.priorityMultiplier).toBe(mult);
    expect(estimate.cost.input).toBeCloseTo(300000 * CUSTOM.input * mult / 1_000_000, 9);
    expect(estimate.priorityLowerBound).toBeUndefined();
  });

  test("lower-bound: a custom band is marked lower bound and gets no priority multiplier", () => {
    expect(findContextTier("xai", "grok-4.6")?.confirmedPriorityRelation).toBe("lower-bound");
    const estimate = price("xai", "grok-4.6", [row("xai", "grok-4.6", CUSTOM)], 300000, PRIORITY)!;
    expect(estimate.contextTier).toBe("long");
    expect(estimate.priorityMultiplier).toBeUndefined();
    expect(estimate.priorityLowerBound).toBe(true);
    expect(estimate.cost.input).toBeCloseTo(300000 * CUSTOM.input / 1_000_000, 9);
  });

  test("unknown relation: a custom band keeps the provider priority multiplier, and flat keeps it too", () => {
    // anthropic/claude-opus-5-5 has a priority rule (response-confirmed) and no context-tier row.
    expect(findContextTier("anthropic", "claude-opus-5-5")).toBeUndefined();
    const mult = findPriorityPricingRule("anthropic", "claude-opus-5-5")!.multiplier;
    const custom = price("anthropic", "claude-opus-5-5", [row("anthropic", "claude-opus-5-5", CUSTOM)], 300000, PRIORITY)!;
    expect(custom.contextTier).toBe("long");
    expect(custom.priorityMultiplier).toBe(mult);
    expect(custom.priorityLowerBound).toBeUndefined();
    expect(custom.cost.input).toBeCloseTo(300000 * CUSTOM.input * mult / 1_000_000, 9);

    const flat = price("anthropic", "claude-opus-5-5", [row("anthropic", "claude-opus-5-5", { policy: "flat" })], 300000, PRIORITY)!;
    expect(flat.contextTier).toBeUndefined();
    expect(flat.priorityMultiplier).toBe(mult);
    expect(flat.cost.input).toBeCloseTo(300000 * BASE.input * mult / 1_000_000, 9);
  });

  test("custom gt and gte boundaries decide whether the band prices the whole request", () => {
    const gt = price("openai", "gpt-5.6-sol", [row("openai", "gpt-5.6-sol", CUSTOM)], 1000)!;
    expect(gt.contextTier).toBeUndefined();
    expect(gt.cost.input).toBeCloseTo(1000 * BASE.input / 1_000_000, 9);
    const gte = price("openai", "gpt-5.6-sol", [row("openai", "gpt-5.6-sol", { ...CUSTOM, comparison: "gte" })], 1000)!;
    expect(gte.contextTier).toBe("long");
    expect(gte.cost.input).toBeCloseTo(1000 * CUSTOM.input / 1_000_000, 9);
  });

  test("automatic legacy: a row without promptPricing keeps the automatic multiplier atop the base", () => {
    const estimate = price("openai", "gpt-5.6-sol", [row("openai", "gpt-5.6-sol")], 300000)!;
    expect(estimate.contextTier).toBe("long");
    expect(estimate.cost.input).toBeCloseTo(300000 * BASE.input * 2 / 1_000_000, 9);
  });

  test("applyPriorityMultiplier keeps the legacy automatic gate when no band source is given", () => {
    const [, multiplier] = applyPriorityMultiplier(BASE, "p", "m", PRIORITY, "long", undefined, tierTable(undefined));
    expect(multiplier).toBe(1);
  });
});
