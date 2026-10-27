import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BridgeError, createBridge, createBuiltInProviders, MistralProvider, mistralDialect, openaiDialect, ProviderHttpError,
  resolveBuiltInProviderConfig, UnsupportedFeatureError,
  type BridgeInput, type MistralInput, type MistralOutput,
} from "../src/index.js";
import { baselineToMistralInput, mistralOutputToBaseline } from "../src/dialects/mistral.js";
import { baselineResponse } from "./fixtures.js";

const output: MistralOutput = {
  id: "cmpl-1", object: "chat.completion", created: 1_700_000_000, model: "magistral-medium-latest",
  choices: [{
    index: 0, finish_reason: "tool_calls",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: [{ type: "text", text: "Need the weather." }], signature: "sig" },
      { type: "text", text: "Checking." },
    ], tool_calls: [{ id: "D681PevKs", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' }, index: 0 }] },
  }],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: 5 } },
};

function http(body: unknown = output, status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetch };
}
const input: BridgeInput = { messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Weather in Paris?" }] };
afterEach(() => vi.unstubAllEnvs());

describe("Mistral chat completions", () => {
  it("sends canonical requests with Mistral field names and maps thinking, tool calls and usage", async () => {
    const net = http();
    const bridge = createBridge({ providers: { lechat: new MistralProvider({ apiKey: "m-key", fetch: net.fetch }) }, dialects: { mistral: mistralDialect, openai: openaiDialect } });
    const response = await bridge.complete({ provider: "lechat", model: "magistral-medium-latest", input: {
      ...input, maxOutputTokens: 200, temperature: 0.2, topP: 0.9, topK: 40, seed: 7, candidates: 1, stop: ["END"],
      toolChoice: "required", parallelToolCalls: false, reasoning: { effort: "high" }, cacheKey: "conversation-1",
      tools: [{ type: "function", name: "weather", description: "Look up weather", inputSchema: { type: "object" }, strict: true }],
      extensions: { mistral: { safe_prompt: true, prompt_mode: "reasoning" } },
    } });
    expect(net.calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(net.calls[0]!.headers.get("authorization")).toBe("Bearer m-key");
    expect(await net.calls[0]!.json()).toEqual({
      model: "magistral-medium-latest", stream: false, safe_prompt: true, prompt_mode: "reasoning",
      messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Weather in Paris?" }],
      max_tokens: 200, temperature: 0.2, top_p: 0.9, top_k: 40, random_seed: 7, n: 1, stop: ["END"],
      tool_choice: "any", parallel_tool_calls: false, reasoning_effort: "high", prompt_cache_key: "conversation-1",
      tools: [{ type: "function", function: { name: "weather", description: "Look up weather", parameters: { type: "object" }, strict: true } }],
    });
    const choice = response.output.choices[0]!;
    expect(choice.finishReason).toBe("tool-calls");
    expect(choice.message.content).toMatchObject([
      { type: "thinking", text: "Need the weather.", signature: "sig" },
      { type: "text", text: "Checking." },
      { type: "tool-call", id: "D681PevKs", name: "weather", input: { city: "Paris" }, arguments: '{"city":"Paris"}' },
    ]);
    expect(response.usage).toMatchObject({ inputTokens: 20, outputTokens: 8, totalTokens: 28, cachedInputTokens: 5 });
    expect(response.raw).toEqual(output);
    expectTypeOf(response.toDialect("mistral")).toEqualTypeOf<MistralOutput>();
    expect(response.toDialect("mistral")).toEqual(output);
    expect(response.toDialect("openai").choices[0]!.message).toMatchObject({ content: "Checking.", tool_calls: [{ id: "D681PevKs" }] });
  });

  it("rewrites foreign tool-call ids to Mistral's 9-character form, consistently for the call and its result", () => {
    const history: BridgeInput = { messages: [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: [{ type: "tool-call", id: "call_abc123XYZ", name: "weather", input: { city: "Paris" } },
        { type: "tool-call", id: "D681PevKs", name: "weather", input: { city: "Rome" } }] },
      { role: "user", content: [{ type: "tool-result", id: "call_abc123XYZ", content: "Sunny" }, { type: "tool-result", id: "D681PevKs", content: "Rain" }] },
    ] };
    const { messages } = baselineToMistralInput(history);
    const calls = messages[1]!.tool_calls!;
    expect(calls[0]!.id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(calls[0]!.id).not.toBe("D681PevKs");
    expect(calls[1]!.id).toBe("D681PevKs");
    expect(messages[1]).not.toHaveProperty("content");
    expect(messages.slice(2)).toEqual([
      { role: "tool", name: "weather", tool_call_id: calls[0]!.id, content: "Sunny" },
      { role: "tool", name: "weather", tool_call_id: "D681PevKs", content: "Rain" },
    ]);
    expect(baselineToMistralInput(history).messages[1]!.tool_calls![0]!.id).toBe(calls[0]!.id);
  });

  it("maps media, documents, files, JSON schema output and developer messages", () => {
    const mapped = baselineToMistralInput({
      messages: [
        { role: "developer", content: "Answer in JSON" },
        { role: "user", content: [
          { type: "text", text: "Read these" },
          { type: "image", source: { type: "url", url: "https://example.test/a.png" }, detail: "high" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AA==" } },
          { type: "document", name: "a.pdf", source: { type: "url", url: "https://example.test/a.pdf" } },
          { type: "document", source: { type: "file", id: "4f7a3c3e-0000-4000-8000-000000000000" } },
          { type: "audio", data: "UklGRg==", format: "wav" },
        ] },
      ],
      responseFormat: { type: "json-schema", name: "answer", schema: { type: "object" }, strict: true },
    });
    expect(mapped.messages).toEqual([
      { role: "system", content: "Answer in JSON" },
      { role: "user", content: [
        { type: "text", text: "Read these" },
        { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "high" } },
        { type: "image_url", image_url: "data:image/png;base64,AA==" },
        { type: "document_url", document_url: "https://example.test/a.pdf", document_name: "a.pdf" },
        { type: "file", file_id: "4f7a3c3e-0000-4000-8000-000000000000" },
        { type: "input_audio", input_audio: "UklGRg==" },
      ] },
    ]);
    expect(mapped.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } });
    expect(baselineToMistralInput({ messages: [], responseFormat: { type: "json" } }).response_format).toEqual({ type: "json_object" });
  });

  it("round-trips native input, keeping Mistral-only fields", async () => {
    const native: MistralInput = {
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: [{ type: "text", text: "Hi" }, { type: "image_url", image_url: "https://example.test/a.png" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "abcDEF123", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "abcDEF123", name: "lookup", content: "found" },
        { role: "assistant", content: "Done", prefix: true },
      ],
      max_tokens: 64, random_seed: 3, tool_choice: { type: "function", function: { name: "lookup" } },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      response_format: { type: "json_object" }, safe_prompt: true, presence_penalty: 0.5,
    };
    const baseline = mistralDialect.toBaseline(native);
    expect(baseline).toMatchObject({ maxOutputTokens: 64, seed: 3, toolChoice: { name: "lookup" }, responseFormat: { type: "json" },
      extensions: { mistral: { safe_prompt: true, presence_penalty: 0.5 } } });
    expect(baseline.messages[3]).toEqual({ role: "user", content: [{ type: "tool-result", id: "abcDEF123", content: "found", extensions: { mistral: { name: "lookup" } } }] });
    const net = http();
    const bridge = createBridge({ providers: { mistral: new MistralProvider({ apiKey: "key", fetch: net.fetch }) }, dialects: { mistral: mistralDialect } });
    await bridge.complete({ provider: "mistral", model: "mistral-small-latest", dialect: "mistral", input: native });
    const sent = await net.calls[0]!.json() as Record<string, unknown>;
    expect(sent).toEqual({ ...native, model: "mistral-small-latest", stream: false,
      messages: [...native.messages.slice(0, 2), { role: "assistant", tool_calls: native.messages[2]!.tool_calls }, ...native.messages.slice(3)] });
    expect(mistralDialect.toBaseline({ messages: [], tool_choice: "any" }).toolChoice).toBe("required");
  });

  it("rejects features Mistral cannot represent instead of dropping them", () => {
    expect(() => baselineToMistralInput({ ...input, reasoning: { effort: "max" } })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ ...input, reasoning: { mode: "enabled" } })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ ...input, cacheControl: { type: "ephemeral" } })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ ...input, extensions: { openai: { store: true } } })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ messages: [{ role: "user", name: "ann", content: "hi" }] })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", id: "f" } }] }] })).toThrow(UnsupportedFeatureError);
    expect(() => baselineToMistralInput({ ...input, extensions: { mistral: { stream: true } } })).toThrow(UnsupportedFeatureError);
  });

  it("maps model_length and error finish reasons, plain string content and absent usage", () => {
    const { usage: _usage, ...withoutUsage } = output;
    const canonical = mistralOutputToBaseline({ ...withoutUsage, choices: [
      { index: 0, finish_reason: "model_length", message: { role: "assistant", content: "partial" } },
      { index: 1, finish_reason: "error", message: { role: "assistant", content: null } },
    ] });
    expect(canonical.choices.map((c) => c.finishReason)).toEqual(["context-limit", "unknown"]);
    expect(canonical.choices[0]!.message.content).toEqual([{ type: "text", text: "partial" }]);
    expect(canonical.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    const projected = mistralDialect.fromBaseline(canonical);
    expect(projected).not.toHaveProperty("usage");
    expect(projected.choices.map((c) => [c.finish_reason, c.message.content])).toEqual([["model_length", "partial"], ["error", ""]]);
    expect(mistralDialect.fromBaseline(baselineResponse())).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 10 } });
    expect(() => mistralOutputToBaseline({ id: "x" })).toThrow(BridgeError);
  });

  it("discovers models with context length and names, keeping the whole card", async () => {
    const card = { id: "mistral-large-latest", object: "model", created: 1_700_000_000, owned_by: "mistralai", name: "mistral-large-2411",
      max_context_length: 131072, aliases: ["mistral-large-2411"], capabilities: { completion_chat: true, function_calling: true }, type: "base" };
    const tuned = { id: "ft:open-mistral-7b:abc", object: "model", created: 0, owned_by: "org", max_context_length: 32768,
      capabilities: { completion_chat: true }, type: "fine-tuned", job: "job-1", root: "open-mistral-7b", archived: false };
    const raw = { object: "list", data: [card, tuned] };
    const net = http(raw);
    const response = await new MistralProvider({ apiKey: "key", baseURL: "https://proxy.test/v1/", fetch: net.fetch }).listModels();
    expect(net.calls[0]!.url).toBe("https://proxy.test/v1/models");
    expect(response).toEqual({ raw, models: [
      { id: card.id, name: card.name, ownedBy: "mistralai", createdAt: "2023-11-14T22:13:20.000Z", maxInputTokens: 131072, raw: card },
      { id: tuned.id, ownedBy: "org", maxInputTokens: 32768, raw: tuned },
    ] });
  });

  it("never falls back to OpenAI credentials and reports HTTP errors", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("MISTRAL_API_KEY", "");
    const net = http();
    const provider = new MistralProvider({ fetch: net.fetch });
    await expect(provider.complete({ model: "m", input })).rejects.toThrow("Mistral requires apiKey or MISTRAL_API_KEY");
    await expect(provider.listModels()).rejects.toThrow("Mistral requires apiKey or MISTRAL_API_KEY");
    expect(net.calls).toHaveLength(0);
    const failing = http({ message: "Unauthorized" }, 401);
    const error = await new MistralProvider({ apiKey: "bad", fetch: failing.fetch }).complete({ model: "m", input }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 401, message: "Mistral returned HTTP 401" });
  });

  it("enables only configured Mistral accounts", () => {
    expect(createBuiltInProviders({ mistral: { apiKey: " " } }, {})).toEqual({});
    expect(resolveBuiltInProviderConfig({}, { MISTRAL_API_KEY: "key" })).toEqual({ mistral: { apiKey: "key", baseURL: "https://api.mistral.ai/v1" } });
    expect(resolveBuiltInProviderConfig({}, { MISTRAL_API_KEY: "key", MISTRAL_BASE_URL: "https://proxy.test/v1" }).mistral?.baseURL).toBe("https://proxy.test/v1");
    expect(createBuiltInProviders({}, { MISTRAL_API_KEY: "key" }).mistral).toBeInstanceOf(MistralProvider);
  });
});
