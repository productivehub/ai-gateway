import { describe, expect, it } from "vitest";
import { UnsupportedFeatureError } from "../src/index.js";
import type { BridgeInput } from "../src/index.js";
import { anthropicInputToBaseline, baselineToAnthropicInput, anthropicOutputToBaseline, baselineToAnthropicOutput } from "../src/dialects/anthropic.js";
import { openAIInputToBaseline, baselineToOpenAIInput, openAIOutputToBaseline, baselineToOpenAIOutput } from "../src/dialects/openai.js";
import { baselineToOllamaInput, ollamaOutputToBaseline } from "../src/dialects/ollama.js";
import { anthropicResponse, openaiResponse, ollamaResponse } from "./fixtures.js";

const tools: NonNullable<BridgeInput["tools"]> = [{ type: "function", name: "lookup", description: "look up a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }];

const history: BridgeInput = {
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Look this up." }, { type: "image", source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" } }] },
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool-call", id: "call-1", name: "lookup", input: { city: "London" } }] },
    { role: "user", content: [{ type: "tool-result", id: "call-1", content: "Sunny" }, { type: "text", text: "Summarize." }] },
  ],
  tools, maxOutputTokens: 100,
};

describe("dialect conversion", () => {
  it("converts text, images, tool definitions, calls and results into OpenAI", () => {
    const native = baselineToOpenAIInput(history);
    expect(native.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "Be brief." }] },
      { role: "user", content: [{ type: "text", text: "Look this up." }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
      { role: "assistant", content: [{ type: "text", text: "Checking." }], tool_calls: [{ type: "function", id: "call-1", function: { name: "lookup", arguments: '{"city":"London"}' } }] },
      { role: "tool", content: "Sunny", tool_call_id: "call-1" },
      { role: "user", content: [{ type: "text", text: "Summarize." }] },
    ]);
    expect(native.tools).toEqual([{ type: "function", function: { name: "lookup", description: "look up a city", parameters: tools[0]!.type === "function" ? tools[0]!.inputSchema : {} } }]);
    expect(native.max_completion_tokens).toBe(100);
    const restored = openAIInputToBaseline(native);
    expect(restored.messages[1]!.content).toContainEqual(expect.objectContaining({ type: "image", source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" } }));
    expect(restored.messages[2]!.content).toContainEqual(expect.objectContaining({ type: "tool-call", input: { city: "London" }, id: "call-1" }));
  });

  it("converts the same history into Anthropic", () => {
    const native = baselineToAnthropicInput(history);
    expect(native.system).toEqual([{ type: "text", text: "Be brief." }]);
    expect(native.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Look this up." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }] },
      { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "call-1", name: "lookup", input: { city: "London" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Sunny" }, { type: "text", text: "Summarize." }] },
    ]);
    expect(native.tools?.[0]).toMatchObject({ name: "lookup", input_schema: { type: "object" } });
  });

  it("converts the same history into native Ollama with tool names and images", () => {
    const native = baselineToOllamaInput(history);
    expect(native.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Look this up.", images: ["aW1hZ2U="] },
      { role: "assistant", content: "Checking.", tool_calls: [{ function: { name: "lookup", arguments: { city: "London" } } }] },
      { role: "tool", tool_name: "lookup", content: "Sunny" },
      { role: "user", content: "Summarize." },
    ]);
    expect(native.options).toEqual({ num_predict: 100 });
  });

  it("preserves Anthropic caching, signed thinking, redaction, error results and provider options", () => {
    const original = {
      messages: [
        { role: "assistant" as const, content: [
          { type: "thinking" as const, thinking: "considering", signature: "signature" },
          { type: "redacted_thinking" as const, data: "redacted" },
          { type: "tool_use" as const, id: "call-1", name: "lookup", input: { city: "London" } },
        ] },
        { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "call-1", content: "failed", is_error: true, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] },
      ],
      system: [{ type: "text" as const, text: "Brief", cache_control: { type: "ephemeral" as const } }],
      tools: [{ name: "lookup", input_schema: { type: "object" as const }, defer_loading: true }],
      max_tokens: 2048, thinking: { type: "enabled" as const, budget_tokens: 1024 },
      tool_choice: { type: "auto" as const, disable_parallel_tool_use: true },
      cache_control: { type: "ephemeral" as const }, metadata: { user_id: "test-user" },
    };
    const canonical = anthropicInputToBaseline(original);
    expect(canonical.reasoning).toEqual({ mode: "enabled", budgetTokens: 1024 });
    expect(canonical.parallelToolCalls).toBe(false);
    expect(baselineToAnthropicInput(canonical)).toEqual(original);
    expect(() => baselineToOpenAIInput(canonical)).toThrow(UnsupportedFeatureError);
  });

  it("retains native server tools and response blocks through the baseline", () => {
    const native = { ...anthropicResponse,
      content: [...anthropicResponse.content, { type: "server_tool_use", id: "web-1", name: "web_search", input: { query: "test" }, caller: { type: "direct" } }] };
    const canonical = anthropicOutputToBaseline(native as typeof anthropicResponse);
    expect(canonical.choices[0]!.message.content).toContainEqual(expect.objectContaining({ type: "native", dialect: "anthropic" }));
    expect(baselineToAnthropicOutput(canonical)).toEqual(native);
  });

  it("retains unrecognized native input options for matching APIs and rejects foreign options", () => {
    const canonical = openAIInputToBaseline({ messages: [{ role: "user", content: "hello" }], logprobs: true, top_logprobs: 2 });
    expect(baselineToOpenAIInput(canonical)).toMatchObject({ logprobs: true, top_logprobs: 2 });
    expect(() => baselineToAnthropicInput(canonical)).toThrow(/openai native fields/);
    expect(() => baselineToOllamaInput(canonical)).toThrow(/openai native fields/);
  });

  it("keeps legacy OpenAI token limits when native input explicitly uses them", () => {
    const native = baselineToOpenAIInput(openAIInputToBaseline({ messages: [], max_tokens: 10 }));
    expect(native.max_tokens).toBe(10);
    expect(native.max_completion_tokens).toBeUndefined();
  });

  it("maps structured output and tool selection in both native APIs", () => {
    const canonical: BridgeInput = { messages: [], tools, toolChoice: { name: "lookup" }, parallelToolCalls: false,
      responseFormat: { type: "json-schema", name: "city", schema: { type: "object" }, strict: true }, reasoning: { effort: "high" } };
    expect(baselineToOpenAIInput(canonical)).toMatchObject({
      tool_choice: { type: "function", function: { name: "lookup" } }, parallel_tool_calls: false, reasoning_effort: "high",
      response_format: { type: "json_schema", json_schema: { name: "city", schema: { type: "object" }, strict: true } },
    });
    expect(baselineToAnthropicInput(canonical)).toMatchObject({
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
      output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
    });
  });

  it("maps audio into OpenAI and rejects it for APIs without audio inputs", () => {
    const canonical: BridgeInput = { messages: [{ role: "user", content: [{ type: "audio", data: "YXVkaW8=", format: "wav" }] }] };
    const native = baselineToOpenAIInput(canonical);
    expect(native.messages[0]).toMatchObject({ content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] });
    expect(openAIInputToBaseline(native).messages[0]!.content).toContainEqual(expect.objectContaining({ type: "audio", data: "YXVkaW8=", format: "wav" }));
    expect(() => baselineToAnthropicInput(canonical)).toThrow(UnsupportedFeatureError);
    expect(() => baselineToOllamaInput(canonical)).toThrow(UnsupportedFeatureError);
  });

  it("maps base64 PDF documents into OpenAI and Anthropic", () => {
    const canonical: BridgeInput = { messages: [{ role: "user", content: [{ type: "document", name: "report.pdf", source: { type: "base64", mediaType: "application/pdf", data: "cGRm" } }] }] };
    expect(baselineToOpenAIInput(canonical).messages[0]).toMatchObject({ content: [{ type: "file", file: { file_data: "data:application/pdf;base64,cGRm", filename: "report.pdf" } }] });
    expect(baselineToAnthropicInput(canonical).messages[0]).toMatchObject({ content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } }] });
  });

  it("accepts original image detail from newer OpenAI SDKs", () => {
    const input: BridgeInput = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/image.png" }, detail: "original" }] }] };
    const native = baselineToOpenAIInput(input);
    expect(native.messages[0]).toMatchObject({ content: [{ type: "image_url", image_url: { detail: "original" } }] });
    expect(openAIInputToBaseline(native).messages[0]!.content).toContainEqual(expect.objectContaining({ detail: "original" }));
  });

  it("does not relabel text documents as PDFs", () => {
    const canonical: BridgeInput = { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", mediaType: "text/plain", data: "aGVsbG8=" } }] }] };
    expect(baselineToAnthropicInput(canonical).messages[0]).toMatchObject({ content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } }] });
    expect(() => baselineToOpenAIInput(canonical)).toThrow(UnsupportedFeatureError);
  });

  it("rejects unsigned thinking replay and contradictory thinking controls", () => {
    expect(() => baselineToAnthropicInput({ messages: [{ role: "assistant", content: [{ type: "thinking", text: "unsigned" }] }] })).toThrow(/without a signature/);
    expect(() => baselineToAnthropicInput({ messages: [], reasoning: { mode: "adaptive", budgetTokens: 1024 } })).toThrow(UnsupportedFeatureError);
  });

  it("maps OpenAI refusal, multiple candidates and token details into the stronger baseline", () => {
    const native = { ...openaiResponse, choices: [
      ...openaiResponse.choices,
      { ...openaiResponse.choices[0]!, index: 1, finish_reason: "content_filter" as const, message: { role: "assistant" as const, content: null, refusal: "Cannot help" } },
    ] };
    const canonical = openAIOutputToBaseline(native);
    expect(canonical.choices).toHaveLength(2);
    expect(canonical.choices[1]).toMatchObject({ finishReason: "content-filter", message: { content: [{ type: "refusal", text: "Cannot help" }] } });
    expect(canonical.usage).toMatchObject({ reasoningTokens: 2, cachedInputTokens: 3 });
    expect(baselineToOpenAIOutput(canonical).choices[1]).toMatchObject(native.choices[1]!);
    expect(() => baselineToAnthropicOutput(canonical)).toThrow(/multiple response candidates/);
  });

  it("preserves malformed OpenAI tool arguments until conversion needs parsed JSON", () => {
    const native = { ...openaiResponse, choices: [{ ...openaiResponse.choices[0]!, message: { role: "assistant" as const, content: null, refusal: null,
      tool_calls: [{ type: "function" as const, id: "bad-call", function: { name: "lookup", arguments: "invalid JSON" } }] } }] };
    const canonical = openAIOutputToBaseline(native);
    expect(baselineToOpenAIOutput(canonical).choices[0]!.message.tool_calls?.[0]).toEqual(native.choices[0]!.message.tool_calls[0]);
    expect(() => baselineToAnthropicOutput(canonical)).toThrow(/invalid JSON tool arguments/);
  });

  it("does not fabricate missing Ollama token counts and retains unsigned thinking", () => {
    const { prompt_eval_count: _input, eval_count: _output, ...native } = ollamaResponse;
    const canonical = ollamaOutputToBaseline(native);
    expect(canonical.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(canonical.choices[0]!.message.content).toContainEqual({ type: "thinking", text: "considering" });
  });

  it.each(["end_turn", "max_tokens", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded", "stop_sequence"] as const)("round-trips Anthropic stop reason %s", (stop_reason) => {
    const native = { ...anthropicResponse, stop_reason, stop_sequence: stop_reason === "stop_sequence" ? "END" : null };
    expect(baselineToAnthropicOutput(anthropicOutputToBaseline(native))).toEqual(native);
  });
});
