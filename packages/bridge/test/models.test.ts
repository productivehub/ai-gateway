import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBridge, createBuiltInProviders, OpenAIProvider, AnthropicProvider, OllamaProvider, OllamaCloudProvider,
  UnknownProviderError, BridgeError, ProviderHttpError,
  type ProviderModelsResponse,
} from "../src/index.js";
import { baselineResponse } from "./fixtures.js";

afterEach(() => vi.unstubAllEnvs());

const openaiModel = { id: "model-1", object: "model", created: 1_700_000_000, owned_by: "test-org", future: true };
const anthropicModel = {
  id: "model-1", type: "model", display_name: "Test model", created_at: "2026-10-04T00:00:00Z",
  max_input_tokens: 200_000, max_tokens: 8192, capabilities: { image_input: { supported: true } },
};
const ollamaModel = {
  name: "org/model:latest", model: "org/model:latest", modified_at: "2026-10-04T00:00:00Z",
  size: 1234, digest: "hash", details: { family: "test" },
};

function transport(replies: { body: unknown; status?: number }[]) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    const next = replies.shift();
    if (!next) throw new Error("Unexpected additional provider request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

describe("bridge model discovery", () => {
  it("dispatches custom providers and preserves metadata and timing", async () => {
    const list: ProviderModelsResponse = { models: [{ id: "my-model", raw: { capability: "custom" } }], raw: { native: true } };
    const listModels = vi.fn(async () => list);
    const complete = vi.fn(async () => ({ output: baselineResponse(), raw: {} }));
    const bridge = createBridge({ providers: { custom: { complete, listModels } } });
    const response = await bridge.listModels({ provider: "custom" });
    expect(response).toMatchObject({ provider: "custom", ...list });
    expect(response.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(response.meta.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(response.meta.endedAt))).toBe(true);
    expect(listModels).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects missing providers and reports unsupported custom discovery", async () => {
    const bridge = createBridge({ providers: { completionOnly: { async complete() { return { output: baselineResponse(), raw: null }; } } } });
    await expect(bridge.listModels({ provider: "unknown" as never })).rejects.toBeInstanceOf(UnknownProviderError);
    await expect(bridge.listModels({ provider: "completionOnly" })).rejects.toMatchObject({
      name: "UnsupportedFeatureError", target: "completionOnly", feature: "model discovery",
    });
    const response = await bridge.complete({ provider: "completionOnly", model: "model", input: { messages: [] } });
    expect(response.output.id).toBe("test-1");
  });

  it("propagates discovery failures", async () => {
    const error = new Error("unavailable");
    const bridge = createBridge({ providers: { custom: {
      async complete() { return { output: baselineResponse(), raw: {} }; },
      async listModels() { throw error; },
    } } });
    await expect(bridge.listModels({ provider: "custom" })).rejects.toBe(error);
  });
});

describe("built-in model discovery", () => {
  it("queries OpenAI with configured credentials and normalizes timestamps", async () => {
    const native = { object: "list", data: [openaiModel] };
    const http = transport([{ body: native }]);
    const bridge = createBridge({ providers: createBuiltInProviders({ openai: { apiKey: "private-key", baseURL: "http://provider.test/v1", fetch: http.fetch } }) });
    const response = await bridge.listModels({ provider: "openai" });
    expect(http.calls[0]?.url).toBe("http://provider.test/v1/models");
    expect(http.calls[0]?.method).toBe("GET");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer private-key");
    expect(response.models).toEqual([{ id: "model-1", ownedBy: "test-org", createdAt: "2023-11-14T22:13:20.000Z", raw: openaiModel }]);
    expect(response.raw).toEqual(native);
    expect(JSON.stringify(response)).not.toContain("private-key");
  });

  it("fetches every Anthropic page and preserves native capabilities", async () => {
    const secondModel = { ...anthropicModel, id: "model-2", max_input_tokens: null, max_tokens: null };
    const first = { data: [anthropicModel], has_more: true, first_id: "model-1", last_id: "model-1" };
    const second = { data: [secondModel], has_more: false, first_id: "model-2", last_id: "model-2" };
    const http = transport([{ body: first }, { body: second }]);
    const provider = new AnthropicProvider({ apiKey: "private-key", baseURL: "http://provider.test", fetch: http.fetch });
    const response = await provider.listModels();
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.url).toBe("http://provider.test/v1/models");
    expect(new URL(http.calls[1]!.url).searchParams.get("after_id")).toBe("model-1");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("private-key");
    expect(response.models[0]).toEqual({
      id: "model-1", name: "Test model", createdAt: "2026-10-04T00:00:00Z",
      maxInputTokens: 200_000, maxOutputTokens: 8192, raw: anthropicModel,
    });
    expect(response.models[1]).not.toHaveProperty("maxInputTokens");
    expect(response.models[1]?.id).toBe("model-2");
    expect(response.raw).toEqual({ pages: [first, second] });
    expect(JSON.stringify(response)).not.toContain("private-key");
  });

  it("propagates errors on later Anthropic pages instead of returning a partial catalog", async () => {
    const http = transport([
      { body: { data: [anthropicModel], has_more: true, first_id: "model-1", last_id: "model-1" } },
      { status: 503, body: { error: { type: "api_error", message: "unavailable" } } },
    ]);
    await expect(new AnthropicProvider({ apiKey: "key", fetch: http.fetch }).listModels()).rejects.toMatchObject({ status: 503 });
    expect(http.calls).toHaveLength(2);
  });

  it.each(["ollama", "ollama-cloud"] as const)("queries native tags for %s", async (name) => {
    const native = { models: [ollamaModel] };
    const http = transport([{ body: native }]);
    const bridge = createBridge({ providers: createBuiltInProviders({ [name]: { apiKey: "private-key", baseURL: "http://provider.test/api/", fetch: http.fetch, timeoutMs: 5000 } }) });
    const response = await bridge.listModels({ provider: name });
    expect(http.calls[0]?.url).toBe("http://provider.test/api/tags");
    expect(http.calls[0]?.method).toBe("GET");
    expect(http.calls[0]?.body).toBeNull();
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer private-key");
    expect(response.models).toEqual([{ id: "org/model:latest", name: "org/model:latest", modifiedAt: "2026-10-04T00:00:00Z", sizeBytes: 1234, raw: ollamaModel }]);
    expect(response.models[0]).not.toHaveProperty("createdAt");
    expect(response.raw).toEqual(native);
  });

  it("accepts Ollama catalogs that identify a model only by name", async () => {
    const http = transport([{ body: { models: [{ name: "cloud-model" }] } }]);
    expect((await new OllamaProvider({ fetch: http.fetch }).listModels()).models[0]?.id).toBe("cloud-model");
  });

  it("uses environment URLs and keys without leaking hosted keys into local Ollama", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://local.test");
    vi.stubEnv("OLLAMA_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "hosted-secret");
    const local = transport([{ body: { models: [] } }]);
    await new OllamaProvider({ fetch: local.fetch }).listModels();
    expect(local.calls[0]?.url).toBe("http://local.test/api/tags");
    expect(local.calls[0]?.headers.has("authorization")).toBe(false);
    vi.stubEnv("OLLAMA_CLOUD_API_KEY", "cloud-key");
    vi.stubEnv("OLLAMA_CLOUD_BASE_URL", "http://cloud.test");
    const cloud = transport([{ body: { models: [] } }]);
    await new OllamaCloudProvider({ fetch: cloud.fetch }).listModels();
    expect(cloud.calls[0]?.url).toBe("http://cloud.test/api/tags");
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer cloud-key");
  });

  it.each(["openai", "anthropic", "ollama", "ollama-cloud"] as const)("allows an empty %s catalog", async (name) => {
    const body = name === "openai" ? { object: "list", data: [] }
      : name === "anthropic" ? { data: [], has_more: false, first_id: null, last_id: null } : { models: [] };
    const http = transport([{ body }]);
    const providers = createBuiltInProviders({ [name]: { apiKey: "key", baseURL: "http://provider.test", fetch: http.fetch } }, {});
    expect((await providers[name]!.listModels()).models).toEqual([]);
  });

  it.each([null, {}, { models: "bad" }, { models: [{}] }, { models: [null] }])("rejects malformed Ollama catalog %#", async (body) => {
    const http = transport([{ body }]);
    await expect(new OllamaProvider({ fetch: http.fetch }).listModels()).rejects.toBeInstanceOf(BridgeError);
  });

  it("requires cloud credentials and propagates HTTP failures", async () => {
    vi.stubEnv("OLLAMA_CLOUD_API_KEY", "");
    vi.stubEnv("OLLAMA_API_KEY", "");
    const http = transport([{ status: 401, body: { error: "denied" } }]);
    await expect(new OllamaCloudProvider({ fetch: http.fetch }).listModels()).rejects.toBeInstanceOf(BridgeError);
    expect(http.calls).toHaveLength(0);
    await expect(new OllamaCloudProvider({ apiKey: "key", fetch: http.fetch }).listModels()).rejects.toBeInstanceOf(ProviderHttpError);
    expect(http.calls).toHaveLength(1);
  });

  it.each([OpenAIProvider, AnthropicProvider])("propagates SDK errors without retries", async (Provider) => {
    const http = transport([{ status: 429, body: { error: { type: "rate_limit_error", message: "limited" } } }]);
    await expect(new Provider({ apiKey: "key", fetch: http.fetch }).listModels()).rejects.toMatchObject({ status: 429 });
    expect(http.calls).toHaveLength(1);
  });
});

async function checkTypes() {
  const bridge = createBridge({ providers: { custom: {
    async complete() { return { output: baselineResponse(), raw: {} }; },
    async listModels() { return { models: [], raw: null }; },
  } } });
  await bridge.listModels({ provider: "custom" });
  // @ts-expect-error Discovery provider names are inferred from the injected registry.
  await bridge.listModels({ provider: "unknown" });
}
void checkTypes;
