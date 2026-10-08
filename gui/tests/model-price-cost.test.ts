import { describe, expect, test } from "bun:test";
import {
  EMPTY_BAND,
  INVALID,
  buildDraftCost,
  loadDraft,
  parseModelCost,
  receiptMatches,
  type BandDraft,
  type ModelCost,
  type RateDraft,
} from "../src/components/model-price-cost";

const RATES = { input: 1.25, output: 9.5, cacheRead: 0.125, cacheWrite: 2.75 };
const BASE: RateDraft = { input: "1.25", output: "9.5", cacheRead: "0.125", cacheWrite: "2.75" };
const BAND: BandDraft = { input: "2.5", output: "19", cacheRead: "", cacheWrite: "", threshold: "200000", comparison: "gt" };
const CUSTOM: ModelCost = {
  ...RATES,
  promptPricing: { policy: "custom", threshold: 200000, comparison: "gt", input: 2.5, output: 19, cacheRead: 0, cacheWrite: 0 },
};

describe("model price contract", () => {
  test("absent and automatic promptPricing both parse to the plain base row", () => {
    expect(parseModelCost(RATES)).toEqual(RATES);
    expect(parseModelCost({ ...RATES, promptPricing: { policy: "automatic" } })).toEqual(RATES);
  });

  test("flat and custom bands parse, and malformed bands are rejected", () => {
    expect(parseModelCost({ ...RATES, promptPricing: { policy: "flat" } }))
      .toEqual({ ...RATES, promptPricing: { policy: "flat" } });
    expect(parseModelCost(CUSTOM)).toEqual(CUSTOM);
    const band = { policy: "custom", comparison: "gt", threshold: 200000, input: 2, output: 3, cacheRead: 0, cacheWrite: 0 };
    for (const promptPricing of [
      { ...band, threshold: 0 },
      { ...band, threshold: 1.5 },
      { ...band, threshold: Number.MAX_SAFE_INTEGER + 1 },
      { ...band, comparison: "lt" },
      { ...band, input: -1 },
      { ...band, output: 1_000_001 },
      { policy: "tiered" },
    ]) {
      expect(parseModelCost({ ...RATES, promptPricing })).toBe(INVALID);
    }
  });

  test("automatic omits promptPricing; flat and custom carry their nested policy", () => {
    expect(buildDraftCost(BASE, "automatic", EMPTY_BAND)).toEqual({ cost: RATES });
    expect(buildDraftCost(BASE, "flat", EMPTY_BAND))
      .toEqual({ cost: { ...RATES, promptPricing: { policy: "flat" } } });
    expect(buildDraftCost(BASE, "custom", BAND)).toEqual({ cost: CUSTOM });
  });

  test("blank cache rates are 0 in both the base row and the band", () => {
    const outcome = buildDraftCost({ ...BASE, cacheRead: "", cacheWrite: "" }, "custom", BAND);
    expect(outcome).toEqual({ cost: { input: 1.25, output: 9.5, cacheRead: 0, cacheWrite: 0, promptPricing: CUSTOM.promptPricing } });
  });

  test("threshold must be a positive safe whole number", () => {
    for (const threshold of ["0", "1.5", "1e3", "007", "-4", "", "9007199254740993"]) {
      expect(buildDraftCost(BASE, "custom", { ...BAND, threshold })).toEqual({ field: "threshold" });
    }
    expect(buildDraftCost(BASE, "custom", { ...BAND, threshold: " 12 " })).toEqual({
      cost: { ...RATES, promptPricing: { policy: "custom", threshold: 12, comparison: "gt", input: 2.5, output: 19, cacheRead: 0, cacheWrite: 0 } },
    });
  });

  test("band errors name the band field, and base errors name the base field", () => {
    expect(buildDraftCost(BASE, "custom", { ...BAND, input: "" })).toEqual({ field: "bandInput" });
    expect(buildDraftCost(BASE, "custom", { ...BAND, output: "1000001" })).toEqual({ field: "bandOutput" });
    expect(buildDraftCost(BASE, "custom", { ...BAND, cacheRead: "-1" })).toEqual({ field: "bandCacheRead" });
    expect(buildDraftCost({ ...BASE, input: "" }, "automatic", EMPTY_BAND)).toEqual({ field: "input" });
    expect(buildDraftCost(BASE, "automatic", EMPTY_BAND, "cacheRead")).toEqual({ field: "cacheRead" });
  });

  test("a receipt must echo the nested policy exactly", () => {
    expect(receiptMatches(CUSTOM, CUSTOM)).toBe(true);
    expect(receiptMatches({ ...CUSTOM, promptPricing: { ...CUSTOM.promptPricing!, comparison: "gte" } }, CUSTOM)).toBe(false);
    expect(receiptMatches(RATES, CUSTOM)).toBe(false);
    expect(receiptMatches({ ...RATES, promptPricing: { policy: "flat" } }, { ...RATES, promptPricing: { policy: "flat" } })).toBe(true);
    expect(receiptMatches(RATES, { ...RATES, promptPricing: { policy: "flat" } })).toBe(false);
    expect(receiptMatches(null, null)).toBe(true);
    expect(receiptMatches(RATES, null)).toBe(false);
  });

  test("loading a saved band restores the custom mode and its values", () => {
    const loaded = loadDraft(CUSTOM);
    expect(loaded.policy).toBe("custom");
    expect(loaded.band).toEqual({ input: "2.5", output: "19", cacheRead: "0", cacheWrite: "0", threshold: "200000", comparison: "gt" });
    expect(loadDraft(RATES).policy).toBe("automatic");
    expect(loadDraft({ ...RATES, promptPricing: { policy: "flat" } }).policy).toBe("flat");
  });
});
