import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridge, createBuiltInProviders, OpenAIProvider, AnthropicProvider, OllamaProvider, OllamaCloudProvider, ProviderHttpError, BridgeError, UnsupportedFeatureError, openaiDialect, anthropicDialect, ollamaDialect } from "../src/index.js";
import { openaiResponse, anthropicResponse, ollamaResponse, transport } from "./fixtures.js";
import type { BridgeInput } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

const input: BridgeInput = { messages: [{ role: "user", content: "hi" }], maxOutputTokens: 32 };

describe("built-in providers", () => {
  it("registers only providers with configured keys or a local base URL", () => {
    expect(createBuiltInProviders({}, {})).toEqual({});
    const bridge = createBridge({ providers: createBuiltInProviders({}, { OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic", OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_CLOUD_API_KEY: "cloud" }) });
    expect(bridge.providers()).toEqual(["openai", "anthropic", "ollama", "ollama-cloud"]);
  });
  it("does not enable Ollama implicitly and ignores empty settings", () => {
    expect(createBuiltInProviders({}, { OPENAI_API_KEY: "", OLLAMA_BASE_URL: "  " })).toEqual({});
    expect(Object.keys(createBuiltInProviders({}, { ANTHROPIC_API_KEY: "claude" }))).toEqual(["anthropic"]);
    expect(Object.keys(createBuiltInProviders({ ollama: { baseURL: "http://local.test" } }, {}))).toEqual(["ollama"]);
    expect(Object.keys(createBuiltInProviders({ ollama: { baseURL: "" } }, { OLLAMA_BASE_URL: "http://local.test" }))).toEqual([]);
    expect(Object.keys(createBuiltInProviders({}, { OLLAMA_CLOUD_API_KEY: "", OLLAMA_API_KEY: "cloud-fallback" }))).toEqual(["ollama-cloud"]);
  });

  it.each(["openai", "anthropic", "ollama", "ollama-cloud"] as const)("calls %s through its native API and returns canonical output", async (name) => {
    const native = name === "openai" ? openaiResponse : name === "anthropic" ? anthropicResponse : ollamaResponse;
    const http = transport(native);
    const providers = createBuiltInProviders({ [name]: { apiKey: "test-key", baseURL: "http://provider.test", fetch: http.fetch } }, {});
    const bridge = createBridge({ providers, dialects: { openai: openaiDialect, anthropic: anthropicDialect, ollama: ollamaDialect } });
    const res = await bridge.complete({ provider: name, model: "test-model", input });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(`http://provider.test${name === "openai" ? "/chat/completions" : name === "anthropic" ? "/v1/messages" : "/api/chat"}`);
    expect(http.calls[0]!.body).toMatchObject({ model: "test-model", stream: false });
    expect(http.calls[0]!.headers.get(name === "anthropic" ? "x-api-key" : "authorization")).toBe(name === "anthropic" ? "test-key" : "Bearer test-key");
    expect(res.output.model).toBe("test-model");
    expect(res.raw).toMatchObject(native);
    expect(res.usage.outputTokens).toBe(4);
    expect(res.toDialect("openai")).toMatchObject({ object: "chat.completion", model: "test-model" });
    expect(res.toDialect("anthropic")).toMatchObject({ type: "message", role: "assistant" });
    expect(res.toDialect("ollama")).toMatchObject({ done: true, model: "test-model" });
    if (name === "openai") expect(http.calls[0]!.body.max_completion_tokens).toBe(32);
    else if (name === "anthropic") expect(http.calls[0]!.body.max_tokens).toBe(32);
    else expect(http.calls[0]!.body.options).toMatchObject({ num_predict: 32 });
  });

  it("retains Anthropic signed thinking and cache accounting while OpenAI projection stays native", async () => {
    const http = transport(anthropicResponse);
    const bridge = createBridge({ providers: { anthropic: new AnthropicProvider({ apiKey: "key", fetch: http.fetch }) }, dialects: { anthropic: anthropicDialect, openai: openaiDialect } });
    const res = await bridge.complete({ provider: "anthropic", model: "test-model", input });
    expect(res.usage).toMatchObject({ inputTokens: 18, outputTokens: 4, totalTokens: 22, cacheWriteTokens: 5, cachedInputTokens: 3, reasoningTokens: 2 });
    expect(res.output.choices[0]!.message.content).toContainEqual(expect.objectContaining({ type: "thinking", signature: "signed" }));
    expect(res.toDialect("anthropic")).toEqual(anthropicResponse);
    expect(res.toDialect("openai").usage).toMatchObject({ prompt_tokens: 18, total_tokens: 22, prompt_tokens_details: { cached_tokens: 3 } });
    expect(res.toDialect("openai").choices[0]!.message).toMatchObject({ content: "hello", tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: '{"city":"London"}' } }] });
  });

  it("uses Ollama native runtime settings and retains nanosecond timings", async () => {
    const http = transport(ollamaResponse);
    const bridge = createBridge({ providers: { local: new OllamaProvider({ fetch: http.fetch, baseURL: "http://local.test/api/" }) }, dialects: { ollama: ollamaDialect } });
    const res = await bridge.complete({ provider: "local", model: "test-model", input: { ...input, keepAlive: "5m", runtimeOptions: { num_ctx: 8192 }, reasoning: { mode: "enabled" }, responseFormat: { type: "json" } } });
    expect(http.calls[0]!.url).toBe("http://local.test/api/chat");
    expect(http.calls[0]!.body).toMatchObject({ keep_alive: "5m", think: true, format: "json", options: { num_ctx: 8192, num_predict: 32 } });
    expect(res.usage.timings).toEqual({ totalMs: 20, loadMs: 2, promptMs: 5, generationMs: 13 });
    expect(res.toDialect("ollama")).toMatchObject(ollamaResponse);
  });

  it.each(["openai", "anthropic"] as const)("accepts %s native input through the same Ollama provider", async (dialect) => {
    const http = transport(ollamaResponse);
    const bridge = createBridge({ providers: { local: new OllamaProvider({ fetch: http.fetch }) }, dialects: { openai: openaiDialect, anthropic: anthropicDialect } });
    if (dialect === "openai") await bridge.complete({ provider: "local", model: "test-model", dialect, input: { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 32 } });
    else await bridge.complete({ provider: "local", model: "test-model", dialect, input: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 } });
    expect(http.calls[0]!.body).toMatchObject({ options: { num_predict: 32 }, messages: [{ role: "user", content: "hi" }] });
  });

  it("resolves credentials and base URLs from environment only when used", async () => {
    const openai = transport(openaiResponse);
    const anthropic = transport(anthropicResponse);
    const cloud = transport(ollamaResponse);
    const bridge = createBridge({ providers: {
      openai: new OpenAIProvider({ fetch: openai.fetch }), anthropic: new AnthropicProvider({ fetch: anthropic.fetch }), cloud: new OllamaCloudProvider({ fetch: cloud.fetch }),
    } });
    vi.stubEnv("OPENAI_API_KEY", "openai-env"); vi.stubEnv("OPENAI_BASE_URL", "http://openai-env.test/v1");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-env"); vi.stubEnv("ANTHROPIC_BASE_URL", "http://anthropic-env.test");
    vi.stubEnv("OLLAMA_CLOUD_API_KEY", "cloud-env"); vi.stubEnv("OLLAMA_CLOUD_BASE_URL", "http://cloud-env.test");
    await bridge.complete({ provider: "openai", model: "test-model", input });
    await bridge.complete({ provider: "anthropic", model: "test-model", input });
    await bridge.complete({ provider: "cloud", model: "test-model", input });
    expect(openai.calls[0]!.url).toBe("http://openai-env.test/v1/chat/completions");
    expect(openai.calls[0]!.headers.get("authorization")).toBe("Bearer openai-env");
    expect(anthropic.calls[0]!.url).toBe("http://anthropic-env.test/v1/messages");
    expect(cloud.calls[0]!.headers.get("authorization")).toBe("Bearer cloud-env");
  });

  it("does not use hosted credentials for local Ollama", async () => {
    vi.stubEnv("OPENAI_API_KEY", "hosted-secret"); vi.stubEnv("OLLAMA_API_KEY", "");
    const http = transport(ollamaResponse);
    await new OllamaProvider({ fetch: http.fetch }).complete({ model: "test-model", input });
    expect(http.calls[0]!.headers.has("authorization")).toBe(false);
    expect(http.calls[0]!.url).toBe("http://localhost:11434/api/chat");
  });

  it("requires an Ollama Cloud key and reports provider HTTP errors without retries", async () => {
    vi.stubEnv("OLLAMA_CLOUD_API_KEY", ""); vi.stubEnv("OLLAMA_API_KEY", "");
    const http = transport({ error: "denied" }, 401);
    await expect(new OllamaCloudProvider({ fetch: http.fetch }).complete({ model: "test-model", input })).rejects.toBeInstanceOf(BridgeError);
    expect(http.calls).toHaveLength(0);
    await expect(new OllamaCloudProvider({ apiKey: "key", fetch: http.fetch }).complete({ model: "test-model", input })).rejects.toMatchObject({ status: 401 });
    expect(http.calls).toHaveLength(1);
    expect(ProviderHttpError.prototype).toBeInstanceOf(BridgeError);
  });

  it.each(["openai", "anthropic"] as const)("propagates %s SDK errors without automatic retries", async (name) => {
    const http = transport({ error: { type: "api_error", message: "unavailable" } }, 503);
    const provider = name === "openai" ? new OpenAIProvider({ apiKey: "key", fetch: http.fetch }) : new AnthropicProvider({ apiKey: "key", fetch: http.fetch });
    await expect(provider.complete({ model: "test-model", input })).rejects.toMatchObject({ status: 503 });
    expect(http.calls).toHaveLength(1);
  });

  it("lets explicit credentials and URLs override environment defaults", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-key"); vi.stubEnv("OPENAI_BASE_URL", "http://env.test/v1");
    const http = transport(openaiResponse);
    await new OpenAIProvider({ apiKey: "explicit-key", baseURL: "http://explicit.test/v1", fetch: http.fetch }).complete({ model: "test-model", input });
    expect(http.calls[0]!.url).toBe("http://explicit.test/v1/chat/completions");
    expect(http.calls[0]!.headers.get("authorization")).toBe("Bearer explicit-key");
  });

  it("rejects unsupported features before making a network request", async () => {
    const http = transport(openaiResponse);
    await expect(new OpenAIProvider({ apiKey: "key", fetch: http.fetch }).complete({ model: "test-model", input: { ...input, reasoning: { mode: "adaptive" } } })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(new AnthropicProvider({ apiKey: "key", fetch: http.fetch }).complete({ model: "test-model", input: { ...input, seed: 42 } })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(new OllamaProvider({ fetch: http.fetch }).complete({ model: "test-model", input: { ...input, toolChoice: "required" } })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(http.calls).toHaveLength(0);
  });

  it("preserves missing usage as null instead of inventing zeros", async () => {
    const { usage: _usage, ...withoutUsage } = openaiResponse;
    const http = transport(withoutUsage);
    const bridge = createBridge({ providers: { openai: new OpenAIProvider({ apiKey: "key", fetch: http.fetch }) }, dialects: { openai: openaiDialect, anthropic: anthropicDialect } });
    const res = await bridge.complete({ provider: "openai", model: "test-model", input });
    expect(res.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(res.toDialect("openai").usage).toBeUndefined();
    expect(() => res.toDialect("anthropic")).toThrow(UnsupportedFeatureError);
  });
});
