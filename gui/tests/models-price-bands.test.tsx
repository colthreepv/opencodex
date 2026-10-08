import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import type { ModelRow } from "../src/pages/models-shared";

type Cost = Record<string, unknown>;
const SAVED = { input: 1.25, output: 9.5, cacheRead: 0.125, cacheWrite: 2.75 };
const CUSTOM_COST = {
  ...SAVED,
  promptPricing: { policy: "custom", threshold: 200000, comparison: "gte", input: 2.5, output: 19, cacheRead: 0.25, cacheWrite: 5 },
};

describe("Models price dialog long-prompt bands", () => {
  const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval"] as const;
  let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
  let testWindow: Window;
  let container: HTMLElement;
  let root: Root | null;
  let modelCosts: Record<string, Cost>;
  let mutations: Array<{ modelId: string; cost: Cost | null }>;
  let putResponse: ((body: { modelId: string; cost: Cost | null }) => Response) | null;

  beforeEach(() => {
    clearClientResourceStoresForTests();
    previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
    testWindow = new Window({ url: "http://localhost/#models" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
      localStorage: { configurable: true, value: testWindow.localStorage },
      sessionStorage: { configurable: true, value: testWindow.sessionStorage },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
      setInterval: { configurable: true, value: () => 1 },
      clearInterval: { configurable: true, value: () => {} },
    });
    const rows: ModelRow[] = [
      { provider: "xai-demo", id: "grok-4.6", namespaced: "xai-demo/grok-4.6", disabled: false, manualPricing: true },
    ];
    const providers = [{ name: "xai-demo", liveModels: false, models: ["grok-4.6"] }];
    modelCosts = { "grok-4.6": { ...SAVED } };
    mutations = [];
    putResponse = null;
    testWindow.localStorage.setItem("ocx-lang", "en");
    testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
    testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
      models: rows, providers, selectedModels: {}, disabled: [], contextCaps: {}, contextCapValue: 350_000,
    }));
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/providers/xai-demo/model-costs")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { modelId: string; cost: Cost | null };
          mutations.push(body);
          if (body.cost === null) delete modelCosts[body.modelId];
          else modelCosts[body.modelId] = body.cost;
          return putResponse ? putResponse(body) : Response.json({ ok: true, provider: "xai-demo", modelId: body.modelId, cost: body.cost });
        }
        return Response.json({ provider: "xai-demo", modelCosts });
      }
      if (url.endsWith("/api/models")) return Response.json(rows);
      if (url.endsWith("/api/providers")) return Response.json(providers);
      if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
      if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
      if (url.endsWith("/api/aliases")) return Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
      if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    container = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(container as never);
    root = null;
  });

  afterEach(async () => {
    clearClientResourceStoresForTests();
    if (root) await act(async () => root!.unmount());
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function flush() {
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  }

  async function open() {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
    });
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit price for xai-demo/grok-4.6"]')!.click());
    await flush();
  }

  function dialog(): HTMLElement {
    return container.querySelector<HTMLElement>("dialog")!;
  }

  function field(name: string): HTMLInputElement | null {
    return dialog().querySelector<HTMLInputElement>(`[data-price-field="${name}"]`);
  }

  function radio(mode: string): HTMLInputElement {
    return dialog().querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!;
  }

  async function choose(mode: string) {
    await act(async () => radio(mode).click());
    await flush();
  }

  async function type(input: HTMLInputElement | null, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
  }

  async function save() {
    await act(async () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
  }

  test("automatic hides long-prompt fields; custom reveals them and flat hides them again", async () => {
    await open();
    expect(radio("automatic").checked).toBe(true);
    expect(field("threshold")).toBeNull();
    await choose("custom");
    expect(field("threshold")).not.toBeNull();
    for (const name of ["bandInput", "bandOutput", "bandCacheRead", "bandCacheWrite"]) expect(field(name)).not.toBeNull();
    await choose("flat");
    expect(field("threshold")).toBeNull();
    expect(dialog().querySelectorAll('input[type="number"]')).toHaveLength(4);
  });

  test("custom saves the full row with the nested band, and blank band cache rates are 0", async () => {
    await open();
    await choose("custom");
    await type(field("threshold"), "200000");
    await type(field("bandInput"), "2.5");
    await type(field("bandOutput"), "19");
    await save();
    expect(mutations).toEqual([{
      modelId: "grok-4.6",
      cost: { ...SAVED, promptPricing: { policy: "custom", threshold: 200000, comparison: "gt", input: 2.5, output: 19, cacheRead: 0, cacheWrite: 0 } },
    }]);
  });

  test("automatic saves without any promptPricing key", async () => {
    await open();
    await save();
    expect(mutations).toHaveLength(1);
    expect(Object.hasOwn(mutations[0]!.cost!, "promptPricing")).toBe(false);
  });

  test("a saved custom band reopens in custom mode with its values", async () => {
    modelCosts["grok-4.6"] = CUSTOM_COST;
    await open();
    expect(radio("custom").checked).toBe(true);
    expect(field("threshold")!.value).toBe("200000");
    expect(field("bandInput")!.value).toBe("2.5");
    expect(field("bandCacheWrite")!.value).toBe("5");
  });

  test("a non-integer threshold blocks the save and names the threshold field", async () => {
    await open();
    await choose("custom");
    await type(field("threshold"), "1.5");
    await type(field("bandInput"), "2");
    await type(field("bandOutput"), "3");
    await save();
    expect(mutations).toHaveLength(0);
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain("whole number");
    expect(field("threshold")!.getAttribute("aria-invalid")).toBe("true");
  });

  test("a receipt that changes the nested comparison enters the outcome-unknown state", async () => {
    await open();
    await choose("custom");
    await type(field("threshold"), "200000");
    await type(field("bandInput"), "2.5");
    await type(field("bandOutput"), "19");
    putResponse = body => Response.json({
      ok: true, provider: "xai-demo", modelId: body.modelId,
      cost: { ...body.cost, promptPricing: { ...(body.cost!.promptPricing as Cost), comparison: "gte" } },
    });
    await save();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain("may have changed");
    expect(field("bandInput")!.disabled).toBe(true);
  });
});
