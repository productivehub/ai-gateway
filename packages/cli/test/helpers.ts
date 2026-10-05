import { vi } from "vitest";
import { createBridge, anthropicDialect, openaiDialect, ollamaDialect, type ProviderRequest, type BridgeOutput } from "@productivehub/ai-bridge";

export function fixture() {
  const complete = vi.fn(async (request: ProviderRequest) => {
    const output: BridgeOutput = {
      id: "response-1", model: request.model, createdAt: "2026-10-04T00:00:00.000Z",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello back" }, finishReason: "stop" }],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };
    return { output, raw: { native: true } };
  });
  const bridge = createBridge({
    providers: { test: { complete }, second: { complete } },
    dialects: {
      anthropic: anthropicDialect, openai: openaiDialect, ollama: ollamaDialect,
      mine: { fromBaseline: (output: BridgeOutput) => ({ answer: output.choices[0]?.message.content }) },
    },
  });
  return { bridge, complete };
}
