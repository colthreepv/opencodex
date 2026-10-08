import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";

const CUSTOM = { policy: "custom", threshold: 1000, comparison: "gt", input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 };
const STORED = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, promptPricing: CUSTOM };

async function run(args: string[], modelCosts: Record<string, unknown>) {
  const calls: Array<{ method: string; body: any }> = [];
  const log = console.log;
  console.log = () => {};
  try {
    const code = await handleModelsRuntimeCommand("set-price", args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, body });
        if (method === "GET") return Response.json({ provider: "custom-price", modelCosts });
        return Response.json({ ok: true, provider: "custom-price", modelId: body.modelId, cost: body.cost });
      },
    });
    return { code, calls, put: calls.find(call => call.method === "PUT") };
  } finally {
    console.log = log;
  }
}

describe("models set-price keeps the nested promptPricing policy", () => {
  test("a custom policy survives a rate change on the same row", async () => {
    const result = await run(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { "org/model": STORED });
    expect(result.code).toBe(0);
    expect(result.put!.body).toEqual({
      modelId: "org/model",
      cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0, promptPricing: CUSTOM },
    });
  });

  test("a flat policy is carried forward as well", async () => {
    const flat = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, promptPricing: { policy: "flat" } };
    const result = await run(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { "org/model": flat });
    expect(result.put!.body.cost.promptPricing).toEqual({ policy: "flat" });
  });

  test("a policy on a sibling model is never carried onto a new row", async () => {
    const result = await run(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { other: STORED });
    expect(result.put!.body.cost).not.toHaveProperty("promptPricing");
  });

  test("--auto reset sends a null cost without reading a policy", async () => {
    const result = await run(["custom-price/org/model", "--auto", "--json"], { "org/model": STORED });
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.method)).toEqual(["PUT"]);
    expect(result.put!.body).toEqual({ modelId: "org/model", cost: null });
  });
});
