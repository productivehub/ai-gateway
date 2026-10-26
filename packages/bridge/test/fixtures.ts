import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { BridgeOutput, OllamaOutput } from "../src/index.js";

export const openaiResponse: OpenAI.Chat.Completions.ChatCompletion = {
  id: "chat-1", object: "chat.completion", created: 1_700_000_000, model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello", refusal: null }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
};

export const anthropicResponse: Anthropic.Messages.Message = {
  id: "msg-1", type: "message", role: "assistant", model: "test-model", container: null, diagnostics: null, stop_details: null,
  content: [
    { type: "thinking", thinking: "considering", signature: "signed" },
    { type: "text", text: "hello", citations: null },
    { type: "tool_use", id: "call-1", name: "lookup", input: { city: "London" }, caller: { type: "direct" } },
  ],
  stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 3,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
    inference_geo: "us", service_tier: "standard", server_tool_use: null, output_tokens_details: { thinking_tokens: 2 } },
};

export const ollamaResponse: OllamaOutput = {
  model: "test-model", created_at: "2026-10-04T00:00:00Z", done: true, done_reason: "stop",
  message: { role: "assistant", content: "hello", thinking: "considering", tool_calls: [{ function: { name: "lookup", arguments: { city: "London" } } }] },
  prompt_eval_count: 10, eval_count: 4, prompt_eval_cached_count: 3,
  total_duration: 20_000_000, load_duration: 2_000_000, prompt_eval_duration: 5_000_000, eval_duration: 13_000_000,
};

export function baselineResponse(): BridgeOutput {
  return { id: "test-1", model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finishReason: "stop" }],
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
}

export function transport(body: unknown, status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown>; signal: AbortSignal }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.json() as Record<string, unknown>, signal: req.signal });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
