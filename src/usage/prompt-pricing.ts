import type { ProviderPromptPricing } from "../types/provider";
import { MAX_COST4_RATE } from "./expected-prices";

/** The custom prompt-size policy, the only variant that carries its own rates. */
export type CustomPromptPricing = Extract<ProviderPromptPricing, { policy: "custom" }>;

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const CUSTOM_KEYS = ["policy", "threshold", "comparison", ...RATE_KEYS] as const;

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COST4_RATE;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate `promptPricing` on one `modelCosts` row. Absent is valid (automatic).
 * Returns a human-readable error, or null when valid. Messages never echo values.
 */
export function promptPricingConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!plainObject(value)) return `${field} must be an object with a policy`;
  const policy = value.policy;
  if (policy === "automatic" || policy === "flat") {
    return Object.keys(value).some(key => key !== "policy")
      ? `${field} ${policy} accepts only policy`
      : null;
  }
  if (policy !== "custom") return `${field}.policy must be automatic, flat, or custom`;
  if (Object.keys(value).some(key => !(CUSTOM_KEYS as readonly string[]).includes(key))) {
    return `${field} has unexpected fields; only policy, threshold, comparison, input, output, cacheRead, and cacheWrite are allowed`;
  }
  if (!Number.isSafeInteger(value.threshold) || (value.threshold as number) <= 0) {
    return `${field}.threshold must be a positive safe integer`;
  }
  if (value.comparison !== "gt" && value.comparison !== "gte") {
    return `${field}.comparison must be gt or gte`;
  }
  for (const key of RATE_KEYS) {
    if (!validRate(value[key])) {
      return `${field}.${key} must be a non-negative finite number at most ${MAX_COST4_RATE} (USD per 1M tokens)`;
    }
  }
  return null;
}

/**
 * Canonical in-memory form of a valid `promptPricing`. Automatic and invalid input both
 * return undefined, so the automatic path is the only result of an absent or legacy row.
 */
export function normalizePromptPricing(value: unknown): ProviderPromptPricing | undefined {
  if (value === undefined || promptPricingConfigError(value, "promptPricing") !== null) return undefined;
  const pricing = value as Record<string, unknown>;
  if (pricing.policy === "automatic") return undefined;
  if (pricing.policy === "flat") return { policy: "flat" };
  return {
    policy: "custom",
    threshold: pricing.threshold as number,
    comparison: pricing.comparison as "gt" | "gte",
    input: pricing.input as number,
    output: pricing.output as number,
    cacheRead: pricing.cacheRead as number,
    cacheWrite: pricing.cacheWrite as number,
  };
}

/** Whether raw prompt tokens (including cache) cross a custom band boundary. */
export function promptPricingCrossed(pricing: CustomPromptPricing, rawInputTokens: number): boolean {
  if (!Number.isFinite(rawInputTokens)) return false;
  return pricing.comparison === "gte"
    ? rawInputTokens >= pricing.threshold
    : rawInputTokens > pricing.threshold;
}
