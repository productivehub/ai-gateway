import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralProvider, XAIProvider } from "@productivehub/ai-bridge";
import { createDefaultGateway, getGatewayCompletionMetadata, listGatewayProviders, resolveDefaultGatewayConfig } from "../src/index.js";

const mistralOutput = { id: "cmpl_1", object: "chat.completion", model: "mistral-large-latest", created: 1_700_000_000,
  choices: [{ index: 0, message: { role: "assistant", content: "Bonjour" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
};
const xaiOutput = { id: "cmpl_2", object: "chat.completion", model: "grok-4.7", created: 1_700_000_000,
  choices: [{ index: 0, message: { role: "assistant", content: "303", refusal: null }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};
const input = { messages: [{ role: "user", content: "Hello" }], maxOutputTokens: 50 };
const post = (body: unknown = input) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function setup(status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (reqInput, init) => {
    const request = new Request(reqInput, init);
    calls.push(request);
    const xai = new URL(request.url).hostname === "api.x.ai";
    const body = status !== 200 ? { error: { message: "private upstream detail" } } : request.method === "GET"
      ? { object: "list", data: [{ id: xai ? "grok-4.7" : "mistral-large-latest", created: 1_700_000_000, owned_by: xai ? "xai" : "mistralai" }] }
      : xai ? xaiOutput : mistralOutput;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  const app = createDefaultGateway({ env: {},
    config: {
      keys: { le: { provider: "mistral", apiKey: "m-secret", inheritEnv: false }, grok: { provider: "xai", apiKey: "x-secret", inheritEnv: false } },
      models: { large: { key: "le", model: "mistral-large-latest" }, grok: { key: "grok", model: "grok-4.7" } },
    },
    providerFactories: {
      mistral: { create: (config) => new MistralProvider({ ...config, fetch }) },
      xai: { create: (config) => new XAIProvider({ ...config, fetch }) },
    },
  });
  return { app, calls };
}
afterEach(() => vi.unstubAllEnvs());

describe("Mistral and xAI gateway", () => {
  it("routes Mistral through its own dialect and native output", async () => {
    const { app, calls } = setup();
    const response = await app.request("/large?dialect=mistral", post());
    expect(response.status).toBe(200);
    expect(getGatewayCompletionMetadata(response)).toMatchObject({ key: "le", provider: "mistral", model: "mistral-large-latest", usage: { totalTokens: 10 } });
    expect(await response.json()).toMatchObject({ provider: "mistral", dialect: "mistral", output: mistralOutput });
    expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer m-secret");
    expect(await calls[0]!.json()).toEqual({ model: "mistral-large-latest", stream: false, max_tokens: 50, messages: [{ role: "user", content: "Hello" }] });
  });

  it("routes xAI through the OpenAI dialect", async () => {
    const { app, calls } = setup();
    const response = await app.request("/grok?dialect=openai", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "xai", dialect: "openai", output: { choices: [{ message: { content: "303" } }] } });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer x-secret");
    expect(await calls[0]!.json()).toMatchObject({ model: "grok-4.7", max_completion_tokens: 50 });
  });

  it.each([["le", "mistral", "https://api.mistral.ai/v1/models", "mistral-large-latest"], ["grok", "xai", "https://api.x.ai/v1/models", "grok-4.7"]])(
    "discovers %s models and answers allowance with 501", async (key, provider, url, id) => {
      const { app, calls } = setup();
      const catalog = await app.request(`/models?key=${key}`);
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toMatchObject({ provider, models: [{ id }] });
      expect(calls[0]!.url).toBe(url);
      expect((await app.request(`/allowance?key=${key}`)).status).toBe(501);
      expect(calls).toHaveLength(1);
    });

  it("registers environment settings and exposes credential-free endpoint metadata", async () => {
    const env = { MISTRAL_API_KEY: "m-secret", XAI_API_KEY: "x-secret", XAI_BASE_URL: "https://proxy.test/v1" };
    const keys = resolveDefaultGatewayConfig({ env }).keys;
    expect(keys.mistral).toMatchObject({ provider: "mistral", apiKey: "m-secret", baseURL: "https://api.mistral.ai/v1" });
    expect(keys.xai).toMatchObject({ provider: "xai", apiKey: "x-secret", baseURL: "https://proxy.test/v1" });
    expect(resolveDefaultGatewayConfig({ env: {} }).keys).not.toHaveProperty("mistral");
    expect(resolveDefaultGatewayConfig({ env: {} }).keys).not.toHaveProperty("xai");
    const body = await (await createDefaultGateway({ env }).request("/keys")).json();
    expect(body).toEqual({ keys: [
      { name: "mistral", provider: "mistral", baseURL: "https://api.mistral.ai/v1", endpoints: { complete: "https://api.mistral.ai/v1/chat/completions", models: "https://api.mistral.ai/v1/models" } },
      { name: "xai", provider: "xai", baseURL: "https://proxy.test/v1", endpoints: { complete: "https://proxy.test/v1/chat/completions", models: "https://proxy.test/v1/models" } },
    ] });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(listGatewayProviders().filter((p) => p.id === "mistral" || p.id === "xai")).toEqual([
      { id: "mistral", defaultBaseURL: "https://api.mistral.ai/v1", requiresApiKey: true, endpoints: ["complete", "models"] },
      { id: "xai", defaultBaseURL: "https://api.x.ai/v1", requiresApiKey: true, endpoints: ["complete", "models"] },
    ]);
    for (const provider of ["mistral", "xai"]) {
      expect(() => createDefaultGateway({ env: {}, config: { keys: { a: { provider } } } })).toThrow("requires a configured API key");
    }
  });

  it.each([[401, 502], [429, 429], [500, 502]])("maps HTTP %i to %i without leaking upstream detail", async (status, expected) => {
    const { app } = setup(status);
    for (const model of ["large", "grok"]) {
      const response = await app.request(`/${model}`, post());
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain("private upstream detail");
    }
  });
});
