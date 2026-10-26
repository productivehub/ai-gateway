import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeError, createBridge, createBuiltInProviders, OpenAIProvider, openaiDialect, ProviderHttpError,
  resolveBuiltInProviderConfig, XAIProvider,
} from "../src/index.js";
import { openaiResponse } from "./fixtures.js";

const input = { messages: [{ role: "user" as const, content: "What is 101*3?" }] };

function recorder(responses: Record<string, { body: unknown; status?: number }>) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (reqInput, init) => {
    const req = new Request(reqInput, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({ url: req.url, headers, body: req.method === "POST" ? await req.json() : undefined });
    const hit = responses[new URL(req.url).pathname];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const completion = {
  ...openaiResponse, model: "grok-4.7", system_fingerprint: "fp_1",
  choices: [{ index: 0, message: { role: "assistant", content: "303", refusal: null, reasoning_content: "101*3" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 32, completion_tokens: 9, total_tokens: 135, num_sources_used: 0, cost_in_usd_ticks: 1_000_000,
    prompt_tokens_details: { text_tokens: 32, audio_tokens: 0, image_tokens: 0, cached_tokens: 6 },
    completion_tokens_details: { reasoning_tokens: 94, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } },
};
const models = { object: "list", data: [
  { id: "grok-4.7", object: "model", created: 1_776_556_800, owned_by: "xai", aliases: ["latest"], context_length: 2_000_000,
    prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 150000,
    capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "high" } },
  { id: "grok-imagine", object: "model", created: 1_776_556_800, owned_by: "xai", aliases: [], prompt_text_token_price: 1250, image_price: 7 },
] };

afterEach(() => vi.unstubAllEnvs());

describe("XAIProvider", () => {
  it("speaks OpenAI Chat Completions to api.x.ai with only the xAI key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
    vi.stubEnv("OPENAI_BASE_URL", "http://openai.invalid");
    vi.stubEnv("OPENAI_ORG_ID", "org-openai");
    vi.stubEnv("XAI_API_KEY", "xai-key");
    const http = recorder({ "/v1/chat/completions": { body: completion } });
    const bridge = createBridge({ providers: { grok: new XAIProvider({ fetch: http.fetch }) }, dialects: { openai: openaiDialect } });
    const response = await bridge.complete({ provider: "grok", model: "grok-4.7", input: { ...input, maxOutputTokens: 100, reasoning: { effort: "low" } } });
    expect(http.calls[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(http.calls[0]!.headers.authorization).toBe("Bearer xai-key");
    expect(http.calls[0]!.headers).not.toHaveProperty("openai-organization");
    expect(http.calls[0]!.body).toMatchObject({ model: "grok-4.7", max_completion_tokens: 100, reasoning_effort: "low" });
    expect(response.output.choices[0]).toMatchObject({ finishReason: "stop", message: { content: [{ type: "text", text: "303" }],
      extensions: { openai: { reasoning_content: "101*3" } } } });
    expect(response.usage).toMatchObject({ inputTokens: 32, outputTokens: 9, cachedInputTokens: 6, reasoningTokens: 94,
      extensions: { openai: { cost_in_usd_ticks: 1_000_000, num_sources_used: 0 } } });
    expect(response.toDialect("openai").choices[0]!.message).toMatchObject({ content: "303", reasoning_content: "101*3" });
  });

  it("maps unknown finish reasons to unknown rather than undefined", async () => {
    const http = recorder({ "/v1/chat/completions": { body: { ...completion, choices: [{ ...completion.choices[0], finish_reason: "end_turn" }] } } });
    const response = await new XAIProvider({ apiKey: "k", fetch: http.fetch }).complete({ model: "grok-4.7", input });
    expect(response.output.choices[0]!.finishReason).toBe("unknown");
  });

  it("lists models with context length and whole-cent per-million prices", async () => {
    const http = recorder({ "/v1/models": { body: models } });
    const listed = await new XAIProvider({ apiKey: "k", fetch: http.fetch }).listModels();
    expect(http.calls[0]!.url).toBe("https://api.x.ai/v1/models");
    expect(listed.models).toEqual([
      { id: "grok-4.7", ownedBy: "xai", createdAt: "2026-04-19T00:00:00.000Z", maxInputTokens: 2_000_000, raw: models.data[0],
        costs: { inputPerMillionTokens: { currency: "USD", amount: 200 }, cachedInputPerMillionTokens: { currency: "USD", amount: 50 },
          outputPerMillionTokens: { currency: "USD", amount: 1500 } } },
      // 1250 cents per 100M tokens is 12.5 cents per million: not a whole minor unit, so it stays in raw only.
      { id: "grok-imagine", ownedBy: "xai", createdAt: "2026-04-19T00:00:00.000Z", raw: models.data[1] },
    ]);
  });

  it("rejects every call before any fetch without an xAI key, and names xAI in HTTP errors", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
    vi.stubEnv("XAI_API_KEY", "");
    const http = recorder({});
    const provider = new XAIProvider({ fetch: http.fetch });
    await expect(provider.complete({ model: "grok-4.7", input })).rejects.toThrow("xAI requires apiKey or XAI_API_KEY");
    await expect(provider.listModels()).rejects.toBeInstanceOf(BridgeError);
    expect(http.calls).toHaveLength(0);
    expect("getAllowance" in provider).toBe(false);
    const failing = recorder({ "/v1/models": { body: { error: "bad key" }, status: 401 } });
    await expect(new XAIProvider({ apiKey: "bad", fetch: failing.fetch }).listModels()).rejects.toMatchObject({ status: 401, message: "xAI returned HTTP 401" });
    await expect(new XAIProvider({ apiKey: "bad", fetch: failing.fetch }).listModels()).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("is registered only when configured and is an OpenAI-compatible adapter", () => {
    expect(createBuiltInProviders({ xai: { apiKey: "" } }, {})).toEqual({});
    expect(resolveBuiltInProviderConfig({}, { XAI_API_KEY: "k" })).toEqual({ xai: { apiKey: "k", baseURL: "https://api.x.ai/v1" } });
    expect(resolveBuiltInProviderConfig({ xai: { baseURL: "https://proxy.test/v1" } }, { XAI_API_KEY: "k", XAI_BASE_URL: "https://ignored.test" }).xai?.baseURL).toBe("https://proxy.test/v1");
    const provider = createBuiltInProviders({}, { XAI_API_KEY: "k" }).xai;
    expect(provider).toBeInstanceOf(XAIProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
