// Contract helpers for the model price dialog. The wire shape mirrors
// providers.<name>.modelCosts in the management API. Automatic prompt pricing is
// the absence of promptPricing; an explicit {policy: "automatic"} is accepted on
// input and normalized away, so the dialog never sends or keeps it.

export const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type RateField = (typeof RATE_FIELDS)[number];
export type Rates = Record<RateField, number>;
export type RateDraft = Record<RateField, string>;
export type Comparison = "gt" | "gte";
export type PromptPricing =
  | { policy: "flat" }
  | ({ policy: "custom"; threshold: number; comparison: Comparison } & Rates);
export type ModelCost = Rates & { promptPricing?: PromptPricing };
export type PromptPolicy = "automatic" | "flat" | "custom";
export interface BandDraft extends RateDraft {
  threshold: string;
  comparison: Comparison;
}
export type InvalidField =
  | RateField
  | "threshold"
  | "bandInput"
  | "bandOutput"
  | "bandCacheRead"
  | "bandCacheWrite";

export const MAX_RATE = 1_000_000;
export const EMPTY_RATES: RateDraft = { input: "", output: "", cacheRead: "", cacheWrite: "" };
export const EMPTY_BAND: BandDraft = { ...EMPTY_RATES, threshold: "", comparison: "gt" };
export const INVALID: unique symbol = Symbol("invalid model cost");

const BAND_FIELD: Record<RateField, InvalidField> = {
  input: "bandInput",
  output: "bandOutput",
  cacheRead: "bandCacheRead",
  cacheWrite: "bandCacheWrite",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE;
}

function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readRates(source: Record<string, unknown>): Rates | null {
  const { input, output, cacheRead, cacheWrite } = source;
  if (!isRate(input) || !isRate(output) || !isRate(cacheRead) || !isRate(cacheWrite)) return null;
  return { input, output, cacheRead, cacheWrite };
}

export function parsePromptPricing(value: unknown): PromptPricing | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return INVALID;
  const { policy, threshold, comparison } = value;
  if (policy === "automatic") return undefined;
  if (policy === "flat") return { policy: "flat" };
  if (policy !== "custom" || !isThreshold(threshold)) return INVALID;
  if (comparison !== "gt" && comparison !== "gte") return INVALID;
  const rates = readRates(value);
  return rates === null ? INVALID : { policy: "custom", threshold, comparison, ...rates };
}

export function parseModelCost(value: unknown): ModelCost | typeof INVALID {
  if (!isRecord(value)) return INVALID;
  const rates = readRates(value);
  if (rates === null) return INVALID;
  const promptPricing = parsePromptPricing(value.promptPricing);
  if (promptPricing === INVALID) return INVALID;
  return promptPricing === undefined ? rates : { ...rates, promptPricing };
}

export function sameModelCost(a: ModelCost, b: ModelCost): boolean {
  if (!RATE_FIELDS.every(field => a[field] === b[field])) return false;
  const pa = a.promptPricing;
  const pb = b.promptPricing;
  if (pa === undefined || pb === undefined) return pa === pb;
  if (pa.policy !== pb.policy) return false;
  if (pa.policy === "flat") return true;
  if (pb.policy !== "custom") return false;
  return pa.threshold === pb.threshold && pa.comparison === pb.comparison
    && RATE_FIELDS.every(field => pa[field] === pb[field]);
}

// A PUT receipt must echo the sent row exactly; null confirms a reset.
export function receiptMatches(receipt: unknown, cost: ModelCost | null): boolean {
  if (cost === null) return receipt === null;
  const parsed = parseModelCost(receipt);
  return parsed !== INVALID && sameModelCost(parsed, cost);
}

function ratesToDraft(rates: Rates): RateDraft {
  return {
    input: String(rates.input),
    output: String(rates.output),
    cacheRead: String(rates.cacheRead),
    cacheWrite: String(rates.cacheWrite),
  };
}

export interface DialogLoad {
  rates: RateDraft;
  policy: PromptPolicy;
  band: BandDraft;
}

export function loadDraft(cost: ModelCost | undefined): DialogLoad {
  if (cost === undefined) return { rates: EMPTY_RATES, policy: "automatic", band: EMPTY_BAND };
  const rates = ratesToDraft(cost);
  const pricing = cost.promptPricing;
  if (pricing === undefined) return { rates, policy: "automatic", band: EMPTY_BAND };
  if (pricing.policy === "flat") return { rates, policy: "flat", band: EMPTY_BAND };
  return {
    rates,
    policy: "custom",
    band: { ...ratesToDraft(pricing), threshold: String(pricing.threshold), comparison: pricing.comparison },
  };
}

export type DraftOutcome = { cost: ModelCost } | { field: InvalidField };

// Blank cache rates are 0, as in the base rows; blank input or output is an error.
const numberOrZero = (text: string) => (text.trim() === "" ? 0 : Number(text));

export function buildDraftCost(
  rates: RateDraft,
  policy: PromptPolicy,
  band: BandDraft,
  badField?: InvalidField,
): DraftOutcome {
  if (badField !== undefined) return { field: badField };
  if (!rates.input.trim()) return { field: "input" };
  if (!rates.output.trim()) return { field: "output" };
  const base: Rates = {
    input: Number(rates.input),
    output: Number(rates.output),
    cacheRead: numberOrZero(rates.cacheRead),
    cacheWrite: numberOrZero(rates.cacheWrite),
  };
  const badBase = RATE_FIELDS.find(field => !isRate(base[field]));
  if (badBase !== undefined) return { field: badBase };
  if (policy === "automatic") return { cost: base };
  if (policy === "flat") return { cost: { ...base, promptPricing: { policy: "flat" } } };

  const threshold = band.threshold.trim();
  if (!/^[1-9]\d*$/.test(threshold) || !isThreshold(Number(threshold))) return { field: "threshold" };
  if (!band.input.trim()) return { field: "bandInput" };
  if (!band.output.trim()) return { field: "bandOutput" };
  const bandRates: Rates = {
    input: Number(band.input),
    output: Number(band.output),
    cacheRead: numberOrZero(band.cacheRead),
    cacheWrite: numberOrZero(band.cacheWrite),
  };
  const badBand = RATE_FIELDS.find(field => !isRate(bandRates[field]));
  if (badBand !== undefined) return { field: BAND_FIELD[badBand] };
  return {
    cost: {
      ...base,
      promptPricing: { policy: "custom", threshold: Number(threshold), comparison: band.comparison, ...bandRates },
    },
  };
}
