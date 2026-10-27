import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BridgeError, createBridge, createBuiltInProviders, OpenAIProvider, openaiDialect, PerplexityProvider,
  perplexityDialect, resolveBuiltInProviderConfig, UnsupportedFeatureError,
  type BridgeInput, type PerplexityInput, type PerplexityOutput,
} from "../src/index.js";
import { baselineToPerplexityInput, perplexityOutputToBaseline } from "../src/dialects/perplexity.js";
import { baselineResponse } from "./fixtures.js";

const citation = { type: "url_citation", start_index: 0, end_index: 6, url: "https://example.test", title: "Source" };
const output: PerplexityOutput = {
  id: "resp_1", model: "provider/resolved", object: "response", created_at: 1_700_000_000, status: "completed", effort: "low@version",
  output: [
    { type: "search_results", id: "search_1", results: [{ url: citation.url, title: citation.title }] },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Answer", annotations: [citation] }, { type: "output_text", text: ".", annotations: [] }] },
    { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "More", annotations: [] }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"query":"x"}', status: "completed", thought_signature: "opaque" },
  ],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
    cost: { currency: "USD", total_cost: 0.002 }, tool_calls_details: { web_search: { count: 1 } } },
  future: { preserved: true },
};
function http(body: unknown = output, status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetch };
}
const input: BridgeInput = { messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Research this" }] };
afterEach(() => vi.unstubAllEnvs());

describe("Perplexity Agent API", () => {
  it("sends canonical requests to /v1/agent and preserves ordered outputs, citations, calls, usage and costs", async () => {
    const net = http();
    const bridge = createBridge({ providers: { research: new PerplexityProvider({ apiKey: "pplx-key", fetch: net.fetch }) }, dialects: { perplexity: perplexityDialect, openai: openaiDialect } });
    const response = await bridge.complete({ provider: "research", model: "provider/model", input: {
      ...input, maxOutputTokens: 200, temperature: 0, topP: 0.8, reasoning: { effort: "high" },
      tools: [{ type: "native", dialect: "perplexity", value: { type: "web_search", filters: { search_domain_filter: ["example.test"] } } }],
      extensions: { perplexity: { max_steps: 3, previous_response_id: "prior" } },
    } });
    expect(net.calls[0]!.url).toBe("https://api.perplexity.ai/v1/agent");
    expect(net.calls[0]!.headers.get("authorization")).toBe("Bearer pplx-key");
    expect(await net.calls[0]!.json()).toMatchObject({ model: "provider/model", stream: false,
      input: [{ type: "message", role: "system", content: "Be concise" }, { type: "message", role: "user", content: "Research this" }],
      max_output_tokens: 200, temperature: 0, top_p: 0.8, reasoning: { effort: "high" }, max_steps: 3, previous_response_id: "prior", tools: [{ type: "web_search" }],
    });
    expect(response.output.choices).toHaveLength(1);
    expect(response.output.choices[0]!.finishReason).toBe("tool-calls");
    expect(response.output.choices[0]!.message.content).toMatchObject([
      { type: "native", dialect: "perplexity" }, { type: "text", text: "Answer", citations: [citation] },
      { type: "text", text: "." }, { type: "text", text: "More" }, { type: "tool-call", id: "call_1", name: "lookup", input: { query: "x" } },
    ]);
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40, cacheWriteTokens: 10, serverToolUsage: { web_search: { count: 1 } }, extensions: { perplexity: { cost: { total_cost: 0.002 } } } });
    expect(response.raw).toEqual(output);
    expectTypeOf(response.toDialect("perplexity")).toEqualTypeOf<PerplexityOutput>();
    expect(response.toDialect("perplexity")).toEqual(output);
    expect(response.toDialect("openai").choices[0]!.message.content).toBe("Answer.More");
  });

  it("converts native input with media, JSON schemas, function definitions and tool results", async () => {
    const native: PerplexityInput = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Read" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_file", file_url: "https://example.test/file.pdf", filename: "file.pdf" }] },
        { type: "function_call", call_id: "c", name: "lookup", arguments: "{}", thought_signature: "signature" },
        { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "result" }], name: "lookup" },
        { type: "mcp_approval_response", approval_request_id: "approval", approve: true },
      ], instructions: "Research", effort: "low", max_steps: 3, max_output_tokens: 512, temperature: 0, top_p: 1,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: true }, { type: "web_search" }],
      tool_choice: { type: "function", name: "lookup" }, reasoning: { effort: "medium" },
      response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" }, strict: true, description: "Answer" } },
    };
    const net = http();
    const bridge = createBridge({ providers: { perplexity: new PerplexityProvider({ apiKey: "key", fetch: net.fetch }) }, dialects: { perplexity: perplexityDialect } });
    await bridge.complete({ provider: "perplexity", model: "provider/model", dialect: "perplexity", input: native });
    expect(await net.calls[0]!.json()).toEqual({ ...native, model: "provider/model", stream: false });
    const basic = perplexityDialect.toBaseline({ input: "Hello" });
    expect(basic.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(baselineToPerplexityInput({ messages: [{ role: "user", content: [{ type: "document", name: "file.pdf", source: { type: "base64", mediaType: "application/pdf", data: "AA==" } }] }] }).input)
      .toEqual([{ type: "message", role: "user", content: [{ type: "input_file", filename: "file.pdf", file_data: "data:application/pdf;base64,AA==" }] }]);
  });

  it("projects canonical responses without Perplexity metadata and reflects edits to native text", () => {
    expect(perplexityDialect.fromBaseline(baselineResponse())).toMatchObject({ object: "response", status: "completed", output: [{ type: "message" }] });
    const canonical = perplexityOutputToBaseline(output);
    const content = canonical.choices[0]!.message.content;
    if (typeof content !== "string" && content[1]?.type === "text") content[1].text = "Changed";
    expect(perplexityDialect.fromBaseline(canonical).output[1]).toMatchObject({ content: [{ text: "Changed" }, { text: "." }] });
    canonical.choices.push(canonical.choices[0]!);
    expect(() => perplexityDialect.fromBaseline(canonical)).toThrow(UnsupportedFeatureError);
  });

  it("handles incomplete output and absent usage without inventing token counts", () => {
    const { usage: _usage, ...withoutUsage } = output;
    const canonical = perplexityOutputToBaseline({ ...withoutUsage, status: "incomplete" });
    expect(canonical.choices[0]!.finishReason).toBe("length");
    expect(canonical.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(perplexityDialect.fromBaseline(canonical)).not.toHaveProperty("usage");
    expect(perplexityDialect.fromBaseline(canonical).status).toBe("incomplete");
  });

  it("discovers models with namespaced IDs and omits placeholder creation dates", async () => {
    const raw = { object: "list", data: [{ id: "provider/model", created: 0, owned_by: "provider" }, { id: "provider/next", created: 1_700_000_000 }] };
    const net = http(raw);
    const response = await new PerplexityProvider({ apiKey: "key", baseURL: "https://proxy.test/v1/", fetch: net.fetch }).listModels();
    expect(net.calls[0]!.url).toBe("https://proxy.test/v1/models");
    expect(net.calls[0]!.method).toBe("GET");
    expect(response).toMatchObject({ raw, models: [{ id: "provider/model", ownedBy: "provider" }, { id: "provider/next", createdAt: "2023-11-14T22:13:20.000Z" }] });
    expect(response.models[0]).not.toHaveProperty("createdAt");
    expect(response.models[0]).not.toHaveProperty("costs");
  });

  it("enables only configured Perplexity accounts and snapshots its own environment", async () => {
    expect(createBuiltInProviders({}, {})).toEqual({});
    expect(createBuiltInProviders({ perplexity: { apiKey: " " } }, { PERPLEXITY_API_KEY: "ambient" })).toEqual({});
    expect(resolveBuiltInProviderConfig({}, { PERPLEXITY_API_KEY: "key", PERPLEXITY_BASE_URL: "https://proxy.test/v1" })).toEqual({ perplexity: { apiKey: "key", baseURL: "https://proxy.test/v1" } });
    expect(createBuiltInProviders({}, { PERPLEXITY_API_KEY: "key" }).perplexity).toBeInstanceOf(PerplexityProvider);
    vi.stubEnv("PERPLEXITY_API_KEY", "captured");
    vi.stubEnv("PERPLEXITY_BASE_URL", "https://captured.test/v1");
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("OPENAI_BASE_URL", "https://openai.invalid");
    vi.stubEnv("OPENAI_ORG_ID", "org");
    const net = http();
    const provider = new PerplexityProvider({ fetch: net.fetch });
    vi.stubEnv("PERPLEXITY_API_KEY", "changed");
    vi.stubEnv("PERPLEXITY_BASE_URL", "https://changed.test/v1");
    await provider.complete({ model: "provider/model", input });
    expect(net.calls[0]!.url).toBe("https://captured.test/v1/agent");
    expect(net.calls[0]!.headers.get("authorization")).toBe("Bearer captured");
    expect(net.calls[0]!.headers.has("openai-organization")).toBe(false);
    const disabled = new PerplexityProvider({ apiKey: "", fetch: net.fetch });
    await expect(disabled.complete({ model: "provider/model", input })).rejects.toThrow("Perplexity requires");
    await expect(disabled.listModels()).rejects.toThrow("Perplexity requires");
    expect(net.calls).toHaveLength(1);
  });

  it.each([401, 429, 500])("preserves HTTP %i without retries", async (status) => {
    const net = http({ error: { message: "private provider detail" } }, status);
    await expect(new PerplexityProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "m", input })).rejects.toMatchObject({ name: "ProviderHttpError", status });
    expect(net.calls).toHaveLength(1);
  });

  it.each([
    { stop: ["stop"] }, { reasoning: { mode: "adaptive" } }, { responseFormat: { type: "json" } },
    { extensions: { openai: { logprobs: true } } }, { extensions: { perplexity: { stream: true } } },
    { extensions: { perplexity: { background: true } } }, { extensions: { perplexity: { models: ["other/model"] } } },
    { extensions: { perplexity: { model: "other/model" } } }, { extensions: { perplexity: { input: "override" } } },
    { messages: [{ role: "user", content: [{ type: "audio", data: "AA==", format: "wav" }] }] },
    { messages: [{ role: "user", content: [{ type: "native", dialect: "openai", value: { type: "file" } }] }] },
  ])("rejects unsupported or routing-changing input before fetching %#", async (extra) => {
    const net = http();
    await expect(new PerplexityProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "m", input: { ...input, ...extra } as BridgeInput })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(net.calls).toHaveLength(0);
  });

  it.each([null, { ...output, output: [null] }, { ...output, status: "failed" }, { ...output, status: "queued" },
    { ...output, created_at: 1e100 }, { ...output, usage: { input_tokens: -1, output_tokens: 0, total_tokens: 0 } },
    { ...output, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: 42 }] }] },
    { ...output, output: [{ type: "function_call", call_id: "c" }] },
  ])("rejects malformed or unfinished responses %#", async (body) => {
    const net = http(body);
    await expect(new PerplexityProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "m", input })).rejects.toBeInstanceOf(BridgeError);
  });

  it.each([{}, { data: [null] }, { data: [{}] }])("rejects malformed catalogs %#", async (body) => {
    const net = http(body);
    await expect(new PerplexityProvider({ apiKey: "key", fetch: net.fetch }).listModels()).rejects.toBeInstanceOf(BridgeError);
  });

  it("applies a timeout signal and rejects foreign-provider native features", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      await new Promise<void>((resolve) => init!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      init!.signal!.throwIfAborted();
      return new Response();
    };
    await expect(new PerplexityProvider({ apiKey: "key", timeoutMs: 5, fetch }).listModels()).rejects.toMatchObject({ name: "TimeoutError" });
    const net = http();
    await expect(new OpenAIProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "m", input: perplexityDialect.toBaseline({ input: "Hi", max_steps: 3 }) })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(net.calls).toHaveLength(0);
  });
});
