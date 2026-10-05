import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, type ProviderConfig, type ProviderRequest } from "@productivehub/ai-bridge";
import { Hono } from "hono";
import { createDefaultGateway, parseGatewayConfig, type GatewayConfig } from "../src/index.js";
import { listenGateway } from "../src/listener.js";
import { post } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());
const config: GatewayConfig = {
  keys: {
    "claude-work": { provider: "anthropic", apiKeyEnv: "WORK_KEY", baseURL: "http://work.test" },
    "claude-personal": { provider: "anthropic", apiKey: "personal-secret", baseURL: "http://personal.test" },
    cloud: { provider: "ollama-cloud", apiKeyEnv: "CLOUD_KEY" },
  },
  models: { writer: { key: "claude-work", model: "claude-model" } },
};

function setup() {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const body = request.method === "GET" ? {
      data: [{ id: "claude-model", type: "model", created_at: "2026-10-04T00:00:00Z", display_name: "Claude" }],
      has_more: false, first_id: "claude-model", last_id: "claude-model",
    } : {
      id: "response", type: "message", model: "claude-model", role: "assistant", content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 },
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const app = createDefaultGateway({
    config, env: { WORK_KEY: "work-secret", CLOUD_KEY: "cloud-secret", OPENAI_API_KEY: "unused-secret" },
    providerFactories: { anthropic: { create: (connection) => new AnthropicProvider({ ...connection, fetch }) } },
  });
  return { app, calls };
}

describe("JSON startup configuration", () => {
  it("lists named accounts and endpoints without returning any secrets or environment references", async () => {
    const { app, calls } = setup();
    const response = await app.request("/keys");
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ["work-secret", "personal-secret", "cloud-secret", "unused-secret", "WORK_KEY", "apiKey"]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({ keys: [
      { name: "claude-work", provider: "anthropic", baseURL: "http://work.test", endpoints: { complete: "http://work.test/v1/messages", models: "http://work.test/v1/models" } },
      { name: "claude-personal", provider: "anthropic", baseURL: "http://personal.test", endpoints: { complete: "http://personal.test/v1/messages", models: "http://personal.test/v1/models" } },
      { name: "cloud", provider: "ollama-cloud", baseURL: "https://ollama.com", endpoints: { complete: "https://ollama.com/api/chat", models: "https://ollama.com/api/tags" } },
    ] });
    expect(calls).toHaveLength(0);
  });

  it("routes a configured model alias to its named account and actual model", async () => {
    const { app, calls } = setup();
    const response = await app.request("/writer?dialect=anthropic", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "claude-work", provider: "anthropic", model: "claude-model", output: { type: "message" } });
    expect(calls[0]?.url).toBe("http://work.test/v1/messages");
    expect(calls[0]?.headers.get("x-api-key")).toBe("work-secret");
    expect(await calls[0]!.json()).toMatchObject({ model: "claude-model" });
  });

  it("selects among multiple accounts using key and discovers their models", async () => {
    const { app, calls } = setup();
    const response = await app.request("/claude-model?key=claude-personal&provider=anthropic", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "claude-personal", provider: "anthropic" });
    expect(calls[0]?.headers.get("x-api-key")).toBe("personal-secret");
    const catalog = await app.request("/models?key=claude-work");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ key: "claude-work", provider: "anthropic", models: [{ id: "claude-model" }] });
  });

  it("lists configured aliases without querying upstream and mounts in director's server", async () => {
    const { app: child, calls } = setup();
    const app = new Hono().route("/api/ai", child);
    expect(await (await app.request("/api/ai/models/configured")).json()).toEqual({ models: [{ name: "writer", key: "claude-work", model: "claude-model", provider: "anthropic" }] });
    expect((await app.request("/api/ai/keys")).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await app.request("/api/ai/writer", post())).status).toBe(200);
  });

  it.each([
    "/claude-model?provider=anthropic", "/claude-model?key=unknown", "/claude-model?key=claude-work&provider=ollama",
    "/writer?key=claude-personal", "/claude-model?key=", "/claude-model?key=claude-work&key=claude-personal",
  ])("rejects ambiguous or conflicting selection %s before upstream calls", async (url) => {
    const { app, calls } = setup();
    expect((await app.request(url, post())).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("supports injected provider factories without changing the JSON provider union", async () => {
    const connections: ProviderConfig[] = [];
    const requests: ProviderRequest[] = [];
    const app = createDefaultGateway({
      config: { keys: { mine: { provider: "custom-service", apiKey: "custom-secret", baseURL: "https://custom.test" } } }, env: {},
      providerFactories: { "custom-service": { requiresApiKey: true, endpoints: { complete: "/chat" }, create(connection) {
        connections.push(connection);
        return { async complete(request) { requests.push(request); return { output: { id: "1", model: request.model, choices: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, raw: {} }; } };
      } } },
    });
    expect((await app.request("/my-model", post())).status).toBe(200);
    expect(connections[0]?.apiKey).toBe("custom-secret");
    expect(requests[0]?.model).toBe("my-model");
    expect(await (await app.request("/keys")).json()).toMatchObject({ keys: [{ name: "mine", provider: "custom-service", endpoints: { complete: "https://custom.test/chat" } }] });
  });

  it.each([
    null, {}, { keys: {}, unexpected: "secret" }, { keys: {}, defaultKey: "missing" },
    { keys: {}, models: { alias: { key: "missing", model: "model" } } },
    { keys: { test: { provider: "anthropic", apiKey: "secret", apiKeyEnv: "KEY" } } },
    { keys: { test: { provider: "anthropic", apiKey: "secret", baseURL: "https://user:password@test.test" } } },
    { keys: { test: { provider: "anthropic", apiKey: "secret", baseURL: "https://test.test?apiKey=secret" } } },
  ])("validates JSON configuration without echoing credential values %#", (value) => {
    expect(() => parseGatewayConfig(value)).toThrow();
    try { parseGatewayConfig(value); } catch (error) { expect(String(error)).not.toContain("password"); }
  });

  it("rejects missing secrets, unregistered providers and implicit localhost", () => {
    expect(() => createDefaultGateway({ config: { keys: { work: { provider: "anthropic", apiKeyEnv: "MISSING" } } }, env: {} })).toThrow("requires a configured API key");
    expect(() => createDefaultGateway({ config: { keys: { local: { provider: "ollama" } } }, env: {} })).toThrow("baseURL or OLLAMA_BASE_URL");
    expect(() => createDefaultGateway({ config: { keys: { test: { provider: "unregistered" } } }, env: {} })).toThrow("unregistered provider");
  });

  it("lets the listener accept config directly, including port and provider credentials", async () => {
    const listener = await listenGateway({ config: { keys: { cloud: { provider: "ollama-cloud", apiKey: "private-secret" } }, port: 0 }, env: { AI_GATEWAY_PORT: "bad" } });
    try {
      expect(listener.port).toBeGreaterThan(0);
      const response = await fetch(`${listener.url}/keys`);
      expect(await response.json()).toMatchObject({ keys: [{ name: "cloud", provider: "ollama-cloud" }] });
    } finally { await listener.close(); }
  });
});

describe("environment-based provider availability", () => {
  it("starts with no providers and never assumes Ollama is running", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://ambient.test");
    const app = createDefaultGateway({ env: {} });
    expect(await (await app.request("/keys")).json()).toEqual({ keys: [] });
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/models?provider=ollama")).status).toBe(400);
    expect((await app.request("/model", post())).status).toBe(400);
  });

  it("enables only providers configured in the supplied environment", async () => {
    const app = createDefaultGateway({ env: { ANTHROPIC_API_KEY: "claude-secret", OLLAMA_BASE_URL: " ", OPENAI_API_KEY: "" } });
    const list = await (await app.request("/keys")).json();
    expect(list).toMatchObject({ keys: [{ name: "anthropic", provider: "anthropic" }] });
    expect(JSON.stringify(list)).not.toContain("claude-secret");
    expect((await app.request("/models?provider=ollama")).status).toBe(400);
  });

  it("enables explicitly configured Ollama and preserves disabled local authentication", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(new Request(input, init).headers.has("authorization")).toBe(false);
      return new Response('{"models":[]}', { headers: { "content-type": "application/json" } });
    });
    const app = createDefaultGateway({ providers: { ollama: { baseURL: "http://local.test", apiKey: "", fetch } }, env: { OLLAMA_API_KEY: "ambient-secret" } });
    expect((await app.request("/models?key=ollama")).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
