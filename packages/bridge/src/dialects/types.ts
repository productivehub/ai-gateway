import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";

export type OpenAIInput = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model" | "stream">;
export type AnthropicInput = Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, "model" | "stream">;
