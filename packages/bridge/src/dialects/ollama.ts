import { randomUUID } from "node:crypto";
import { evaluationContentToText } from "../evaluation.js";
import type { ContentBlock, BridgeInput, BridgeMessage, BridgeOutput, BridgeUsage } from "../baseline.js";
import type { DialectService } from "../types.js";
import { blocks, extras, nativeFields, requestFields, requireAbsent, textOnly, toolInput, unsupported } from "./shared.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  images?: string[];
  tool_name?: string;
  tool_calls?: { function: { name: string; arguments: unknown; [key: string]: unknown }; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface OllamaOutput {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  [key: string]: unknown;
}

function toMessages(message: BridgeMessage, toolNames: Map<string, string>): OllamaMessage[] {
  const extra = requestFields(message.extensions, "ollama");
  if (message.name) unsupported("ollama", "named message");
  const content: string[] = [];
  const images: string[] = [];
  const thinking: string[] = [];
  const calls: NonNullable<OllamaMessage["tool_calls"]> = [];
  const results: OllamaMessage[] = [];
  for (const block of blocks(message)) {
    if (block.cacheControl) unsupported("ollama", "content cacheControl");
    const fields = requestFields(block.extensions, "ollama");
    if (block.type !== "tool-call" && block.type !== "native" && Object.keys(fields).length) unsupported("ollama", `${block.type} block native metadata`);
    switch (block.type) {
      case "text":
        if (block.citations?.length) unsupported("ollama", "input citations");
        content.push(block.text); break;
      case "thinking":
        if (block.signature) unsupported("ollama", "signed thinking replay");
        thinking.push(block.text); break;
      case "image":
        if (block.detail || block.source.type !== "base64") unsupported("ollama", "image input requires base64 without detail");
        images.push(block.source.data); break;
      case "tool-call":
        toolNames.set(block.id, block.name);
        calls.push({ ...fields, function: { ...(fields.function as object | undefined), name: block.name, arguments: toolInput(block.input, block.arguments, "ollama") } }); break;
      case "tool-result": {
        if (block.isError) unsupported("ollama", "tool-result isError");
        const name = toolNames.get(block.id);
        if (!name) unsupported("ollama", `tool result ${block.id} without its preceding tool call`);
        results.push({ ...fields, role: "tool", tool_name: name, content: typeof block.content === "string" ? block.content : textOnly(block.content, "ollama") }); break;
      }
      case "native":
        if (block.dialect !== "ollama") unsupported("ollama", `${block.dialect} content block`);
        results.push(block.value as unknown as OllamaMessage); break;
      default: unsupported("ollama", `${block.type} content block`);
    }
  }
  const own = content.length || images.length || calls.length || thinking.length || !results.length ? [{
    ...extra, role: message.role === "developer" ? "system" as const : message.role, content: content.join(""),
    ...(images.length ? { images } : {}), ...(thinking.length ? { thinking: thinking.join("") } : {}), ...(calls.length ? { tool_calls: calls } : {}),
  }] : [];
  return [...results, ...own];
}

export function baselineToOllamaInput(input: BridgeInput): Record<string, unknown> {
  requireAbsent("ollama", input, ["cacheControl", "cacheKey", "cacheRetention", "parallelToolCalls"]);
  if (input.toolChoice !== undefined && input.toolChoice !== "auto") unsupported("ollama", "forced tool choice");
  if (input.candidates !== undefined && input.candidates !== 1) unsupported("ollama", "multiple candidates");
  if (input.reasoning) requireAbsent("ollama", input.reasoning, ["budgetTokens", "display"]);
  if (input.reasoning?.mode === "adaptive") unsupported("ollama", "adaptive thinking mode");
  const options = { ...input.runtimeOptions,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.topK !== undefined ? { top_k: input.topK } : {}),
    ...(input.maxOutputTokens !== undefined ? { num_predict: input.maxOutputTokens } : {}),
    ...(input.stop ? { stop: input.stop } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}) };
  const tools = input.tools?.map((tool) => {
    if (tool.type === "native") return tool.dialect === "ollama" ? tool.value : unsupported("ollama", `${tool.dialect} tool`);
    if (tool.cacheControl || tool.strict !== undefined) unsupported("ollama", "tool cacheControl/strict");
    return { type: "function", function: { ...requestFields(tool.extensions, "ollama"), name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}), parameters: tool.inputSchema } };
  });
  const toolNames = new Map<string, string>();
  return {
    ...requestFields(input.extensions, "ollama"), messages: input.messages.flatMap((m) => toMessages(m, toolNames)),
    ...(Object.keys(options).length ? { options } : {}), ...(tools ? { tools } : {}),
    ...(input.keepAlive !== undefined ? { keep_alive: input.keepAlive } : {}),
    ...(input.reasoning?.effort !== undefined ? { think: input.reasoning.effort === "none" ? false : input.reasoning.effort }
      : input.reasoning?.mode ? { think: input.reasoning.mode === "enabled" } : {}),
    ...(input.responseFormat?.type === "json" ? { format: "json" }
      : input.responseFormat?.type === "json-schema" ? { format: input.responseFormat.schema } : {}),
  };
}

export function ollamaOutputToBaseline(output: OllamaOutput): BridgeOutput {
  const id = `ollama-${randomUUID()}`;
  const content: ContentBlock[] = [];
  if (output.message.thinking) content.push({ type: "thinking", text: output.message.thinking });
  if (output.message.content) content.push({ type: "text", text: output.message.content });
  for (const [index, call] of (output.message.tool_calls ?? []).entries()) content.push({
    type: "tool-call", id: `${id}-tool-${index}`, name: call.function.name, input: call.function.arguments,
    extensions: nativeFields("ollama", { ...extras(call, ["function"]), function: extras(call.function, ["name", "arguments"]) }),
  });
  const inputTokens = output.prompt_eval_count ?? null;
  const outputTokens = output.eval_count ?? null;
  const usage: BridgeUsage = {
    inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    ...(output.prompt_eval_cached_count !== undefined ? { cachedInputTokens: output.prompt_eval_cached_count } : {}),
    timings: {
      ...(output.total_duration !== undefined ? { totalMs: output.total_duration / 1e6 } : {}),
      ...(output.load_duration !== undefined ? { loadMs: output.load_duration / 1e6 } : {}),
      ...(output.prompt_eval_duration !== undefined ? { promptMs: output.prompt_eval_duration / 1e6 } : {}),
      ...(output.eval_duration !== undefined ? { generationMs: output.eval_duration / 1e6 } : {}),
    },
    extensions: nativeFields("ollama", extras(output, ["model", "created_at", "message", "done", "done_reason"])),
  };
  return {
    id, model: output.model, createdAt: output.created_at, usage,
    choices: [{ index: 0, message: { role: "assistant", content,
      extensions: nativeFields("ollama", extras(output.message, ["role", "content", "thinking", "tool_calls"])) },
      finishReason: output.message.tool_calls?.length ? "tool-calls" : output.done_reason === "length" ? "length" : "stop",
      ...(output.logprobs !== undefined ? { logprobs: output.logprobs } : {}),
    }],
    extensions: { ollama: { done: output.done, done_reason: output.done_reason } },
  };
}

export function baselineToOllamaOutput(output: BridgeOutput): OllamaOutput {
  if (output.choices.length !== 1) return unsupported("ollama", "multiple response candidates");
  const choice = output.choices[0]!;
  const content = evaluationContentToText(blocks(choice.message), "ollama");
  const calls = content.filter((b) => b.type === "tool-call").map((b) => ({
    ...b.extensions?.ollama, function: { ...(b.extensions?.ollama?.function as object | undefined), name: b.name, arguments: toolInput(b.input, b.arguments, "ollama") },
  }));
  return {
    ...output.usage.extensions?.ollama, ...output.extensions?.ollama,
    model: output.model, created_at: output.createdAt ?? new Date().toISOString(), done: true,
    done_reason: choice.finishReason === "length" ? "length" : "stop",
    message: { ...choice.message.extensions?.ollama, role: "assistant", content: content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      ...(content.some((b) => b.type === "thinking") ? { thinking: content.filter((b) => b.type === "thinking").map((b) => b.text).join("") } : {}),
      ...(calls.length ? { tool_calls: calls } : {}) },
    ...(output.usage.inputTokens !== null ? { prompt_eval_count: output.usage.inputTokens } : {}),
    ...(output.usage.outputTokens !== null ? { eval_count: output.usage.outputTokens } : {}),
    ...(output.usage.cachedInputTokens !== undefined ? { prompt_eval_cached_count: output.usage.cachedInputTokens } : {}),
    ...(output.usage.timings?.totalMs !== undefined ? { total_duration: output.usage.timings.totalMs * 1e6 } : {}),
    ...(output.usage.timings?.loadMs !== undefined ? { load_duration: output.usage.timings.loadMs * 1e6 } : {}),
    ...(output.usage.timings?.promptMs !== undefined ? { prompt_eval_duration: output.usage.timings.promptMs * 1e6 } : {}),
    ...(output.usage.timings?.generationMs !== undefined ? { eval_duration: output.usage.timings.generationMs * 1e6 } : {}),
  };
}

export const ollamaDialect = { fromBaseline: baselineToOllamaOutput } satisfies DialectService<never, OllamaOutput>;
