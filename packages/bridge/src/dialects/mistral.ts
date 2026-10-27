import { createHash } from "node:crypto";
import type { BridgeChoice, BridgeInput, BridgeMessage, BridgeOutput, BridgeTool, BridgeUsage, ContentBlock, FinishReason, JSONSchema } from "../baseline.js";
import type { DialectService } from "../types.js";
import { BridgeError } from "../errors.js";
import { evaluationContentToText } from "../evaluation.js";
import { blocks, extras, nativeFields, parseArguments, requestFields, requireAbsent, unsupported } from "./shared.js";

/** Content chunk: text, image_url, document_url, file, input_audio, thinking, reference, ... */
export interface MistralChunk { type: string; [key: string]: unknown }
export interface MistralToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string | Record<string, unknown> };
  index?: number;
  [key: string]: unknown;
}
export interface MistralMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | MistralChunk[] | null;
  tool_calls?: MistralToolCall[] | null;
  tool_call_id?: string | null;
  name?: string | null;
  prefix?: boolean;
  [key: string]: unknown;
}
export interface MistralTool {
  type: "function";
  function: { name: string; description?: string; parameters: JSONSchema; strict?: boolean };
}
/** Chat Completions request without model/stream; the bridge request supplies the model. */
export interface MistralInput {
  messages: MistralMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  random_seed?: number;
  n?: number;
  tools?: (MistralTool | Record<string, unknown>)[];
  tool_choice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  prompt_mode?: "reasoning" | null;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: { name: string; schema: JSONSchema; strict?: boolean; description?: string } };
  prompt_cache_key?: string;
  safe_prompt?: boolean;
  [key: string]: unknown;
}
export interface MistralUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; [key: string]: unknown };
  prompt_audio_seconds?: number | null;
  service_tier?: string | null;
  [key: string]: unknown;
}
export interface MistralOutput {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: MistralMessage & { role: "assistant" };
    finish_reason: "stop" | "length" | "model_length" | "error" | "tool_calls";
    logprobs?: unknown;
    [key: string]: unknown;
  }[];
  usage?: MistralUsage;
  [key: string]: unknown;
}

const target = "mistral";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** Mistral accepts only 9-character alphanumeric tool-call ids. */
const MISTRAL_TOOL_ID = /^[A-Za-z0-9]{9}$/;
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Rewrites foreign ids (call_…, toolu_…) to valid ones, the same for a call and its result within one request. */
function toolIds(messages: BridgeMessage[]): (id: string) => string {
  const used = new Set<string>();
  for (const message of messages) for (const block of blocks(message)) {
    if ((block.type === "tool-call" || block.type === "tool-result") && MISTRAL_TOOL_ID.test(block.id)) used.add(block.id);
  }
  const mapped = new Map<string, string>();
  return (id) => {
    if (MISTRAL_TOOL_ID.test(id)) return id;
    const known = mapped.get(id);
    if (known) return known;
    let value: string;
    let attempt = 0;
    do {
      const digest = createHash("sha256").update(`${id}\0${attempt++}`).digest();
      value = Array.from(digest.subarray(0, 9), (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join("");
    } while (used.has(value));
    mapped.set(id, value);
    used.add(value);
    return value;
  };
}

function dataURL(source: { mediaType: string; data: string }): string {
  return `data:${source.mediaType};base64,${source.data}`;
}

function toChunk(block: ContentBlock): MistralChunk {
  if (block.cacheControl) unsupported(target, "content cacheControl");
  const extra = requestFields(block.extensions, target);
  switch (block.type) {
    case "text":
      if (block.citations?.length) unsupported(target, "input citations");
      return { ...extra, type: "text", text: block.text };
    case "image": {
      if (block.source.type === "file") return unsupported(target, "image file id");
      if (block.detail === "original") unsupported(target, "image detail original");
      const url = block.source.type === "url" ? block.source.url : dataURL(block.source);
      return { ...extra, type: "image_url", image_url: block.detail ? { url, detail: block.detail } : url };
    }
    case "document":
      if (block.source.type === "file") return { ...extra, type: "file", file_id: block.source.id };
      return { ...extra, type: "document_url", document_url: block.source.type === "url" ? block.source.url : dataURL(block.source),
        ...(block.name ? { document_name: block.name } : {}) };
    // Mistral detects the audio container from the data; the chunk carries no format field.
    case "audio": return { ...extra, type: "input_audio", input_audio: block.data };
    case "native": return block.dialect === target ? block.value as MistralChunk : unsupported(target, `${block.dialect} content block`);
    default: return unsupported(target, `${block.type} content block`);
  }
}

function thinkingChunk(block: Extract<ContentBlock, { type: "thinking" }>): MistralChunk {
  if (block.cacheControl) unsupported(target, "content cacheControl");
  return { ...requestFields(block.extensions, target), type: "thinking", thinking: [{ type: "text", text: block.text }],
    ...(block.signature !== undefined ? { signature: block.signature } : {}) };
}

function toMessages(message: BridgeMessage, toolId: (id: string) => string, toolNames: Map<string, string>): MistralMessage[] {
  if (message.name) unsupported(target, "named message");
  const extra = requestFields(message.extensions, target);
  if (message.role === "system" || message.role === "developer") {
    const content = typeof message.content === "string" ? message.content : message.content.map((block) => {
      if (block.type !== "text" && !(block.type === "native" && block.dialect === target)) return unsupported(target, `${block.type} system content`);
      return toChunk(block);
    });
    return [{ ...extra, role: "system", content }];
  }
  if (message.role === "assistant") {
    if (typeof message.content === "string") return [{ ...extra, role: "assistant", content: message.content }];
    const chunks: MistralChunk[] = [];
    const calls: MistralToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "thinking") { chunks.push(thinkingChunk(block)); continue; }
      if (block.type !== "tool-call") { chunks.push(toChunk(block)); continue; }
      if (block.cacheControl) unsupported(target, "content cacheControl");
      if (block.arguments === undefined && block.input === undefined) unsupported(target, "missing tool-call arguments");
      toolNames.set(block.id, block.name);
      const fields = requestFields(block.extensions, target);
      calls.push({ ...fields, id: toolId(block.id), type: "function",
        function: { name: block.name, arguments: block.arguments ?? JSON.stringify(block.input) } });
    }
    return [{ ...extra, role: "assistant", ...(chunks.length ? { content: chunks } : calls.length ? {} : { content: "" }), ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  if (typeof message.content === "string") return [{ ...extra, role: "user", content: message.content }];
  const messages: MistralMessage[] = [];
  let chunks: MistralChunk[] = [];
  const flush = () => { if (chunks.length) { messages.push({ ...extra, role: "user", content: chunks }); chunks = []; } };
  for (const block of message.content) {
    if (block.type !== "tool-result") { chunks.push(toChunk(block)); continue; }
    flush();
    if (block.isError !== undefined || block.cacheControl) unsupported(target, "tool-result isError/cacheControl");
    const fields = requestFields(block.extensions, target);
    const name = toolNames.get(block.id);
    messages.push({ ...(name ? { name } : {}), ...fields, role: "tool", tool_call_id: toolId(block.id),
      content: typeof block.content === "string" ? block.content : block.content.map(toChunk) });
  }
  flush();
  if (!messages.length) messages.push({ ...extra, role: "user", content: "" });
  return messages;
}

function toTool(tool: BridgeTool): MistralTool | Record<string, unknown> {
  if (tool.type === "native") return tool.dialect === target ? tool.value : unsupported(target, `${tool.dialect} tool`);
  if (tool.cacheControl) unsupported(target, "tool cacheControl");
  return { type: "function", function: { ...requestFields(tool.extensions, target), name: tool.name, parameters: tool.inputSchema,
    ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
}

export function baselineToMistralInput(input: BridgeInput): MistralInput {
  requireAbsent(target, input, ["cacheControl", "cacheRetention", "keepAlive", "runtimeOptions"]);
  if (input.reasoning) {
    requireAbsent(target, input.reasoning, ["mode", "budgetTokens", "display"]);
    if (input.reasoning.effort !== undefined && !efforts.includes(input.reasoning.effort)) unsupported(target, `reasoning effort ${input.reasoning.effort}`);
  }
  const extra = requestFields(input.extensions, target);
  requireAbsent(target, extra, ["model", "messages"]);
  if (extra.stream !== undefined && extra.stream !== false) unsupported(target, "streaming");
  const toolId = toolIds(input.messages);
  const toolNames = new Map<string, string>();
  const format = input.responseFormat;
  const choice = input.toolChoice;
  return {
    ...extra, messages: input.messages.flatMap((message) => toMessages(message, toolId, toolNames)),
    ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.topK !== undefined ? { top_k: input.topK } : {}),
    ...(input.stop ? { stop: input.stop } : {}),
    ...(input.seed !== undefined ? { random_seed: input.seed } : {}),
    ...(input.candidates !== undefined ? { n: input.candidates } : {}),
    ...(input.tools ? { tools: input.tools.map(toTool) } : {}),
    // "any" is Mistral's original spelling of a forced tool call, accepted by every model.
    ...(choice !== undefined ? { tool_choice: typeof choice === "string" ? choice === "required" ? "any" : choice : { type: "function", function: { name: choice.name } } } : {}),
    ...(input.parallelToolCalls !== undefined ? { parallel_tool_calls: input.parallelToolCalls } : {}),
    ...(input.reasoning?.effort !== undefined ? { reasoning_effort: input.reasoning.effort as NonNullable<MistralInput["reasoning_effort"]> } : {}),
    ...(format ? { response_format: format.type === "json-schema" ? { type: "json_schema", json_schema: {
      ...(record(extra.response_format) && record(extra.response_format.json_schema) ? extra.response_format.json_schema : {}),
      name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}),
    } } : { type: format.type === "json" ? "json_object" : "text" } } : {}),
    ...(input.cacheKey ? { prompt_cache_key: input.cacheKey } : {}),
  };
}

/** Converts a response or native-input chunk; anything without a portable equivalent stays native. */
function fromChunk(chunk: MistralChunk): ContentBlock {
  if (!record(chunk) || typeof chunk.type !== "string") unsupported(target, "invalid content chunk");
  if (chunk.type === "text" && typeof chunk.text === "string") return { type: "text", text: chunk.text, extensions: nativeFields(target, extras(chunk, ["type", "text"])) };
  if (chunk.type === "thinking" && Array.isArray(chunk.thinking) && chunk.thinking.every((part) => record(part) && part.type === "text" && typeof part.text === "string")) {
    return { type: "thinking", text: (chunk.thinking as { text: string }[]).map((part) => part.text).join(""),
      ...(typeof chunk.signature === "string" ? { signature: chunk.signature } : {}),
      extensions: nativeFields(target, extras(chunk, ["type", "thinking", "signature"])) };
  }
  if (chunk.type === "image_url") {
    const image = chunk.image_url;
    const url = typeof image === "string" ? image : record(image) && typeof image.url === "string" ? image.url : undefined;
    const detail = record(image) ? image.detail : undefined;
    if (url !== undefined && (detail == null || detail === "low" || detail === "auto" || detail === "high")) {
      const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return { type: "image", source: data ? { type: "base64", mediaType: data[1]!, data: data[2]! } : { type: "url", url }, ...(detail ? { detail } : {}) };
    }
  }
  if (chunk.type === "document_url" && typeof chunk.document_url === "string") {
    const data = /^data:([^;]+);base64,(.*)$/s.exec(chunk.document_url);
    return { type: "document", source: data ? { type: "base64", mediaType: data[1]!, data: data[2]! } : { type: "url", url: chunk.document_url },
      ...(typeof chunk.document_name === "string" ? { name: chunk.document_name } : {}) };
  }
  if (chunk.type === "file" && typeof chunk.file_id === "string") return { type: "document", source: { type: "file", id: chunk.file_id } };
  return { type: "native", dialect: target, value: chunk };
}

function fromContent(content: MistralMessage["content"]): ContentBlock[] {
  if (content == null || content === "") return [];
  return typeof content === "string" ? [{ type: "text", text: content }] : content.map(fromChunk);
}

function fromCall(call: MistralToolCall): ContentBlock {
  if (!record(call) || !record(call.function) || typeof call.function.name !== "string") throw new BridgeError("Mistral returned an invalid tool call");
  const args = call.function.arguments;
  if (typeof args !== "string" && !record(args)) throw new BridgeError("Mistral returned invalid tool-call arguments");
  return { type: "tool-call", id: typeof call.id === "string" ? call.id : "", name: call.function.name,
    input: typeof args === "string" ? parseArguments(args) : args, ...(typeof args === "string" ? { arguments: args } : {}),
    extensions: nativeFields(target, extras(call, ["id", "type", "function"])) };
}

export function mistralInputToBaseline(input: MistralInput): BridgeInput {
  if (!record(input) || !Array.isArray(input.messages)) unsupported(target, "messages must be an array");
  const messages = input.messages.map((message): BridgeMessage => {
    if (!record(message) || !["system", "user", "assistant", "tool"].includes(String(message.role))) return unsupported(target, "invalid message");
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string") unsupported(target, "tool message without tool_call_id");
      return { role: "user", content: [{ type: "tool-result", id: message.tool_call_id,
        content: typeof message.content === "string" ? message.content : fromContent(message.content),
        extensions: nativeFields(target, extras(message, ["role", "content", "tool_call_id"])) }] };
    }
    const calls = message.role === "assistant" ? (message.tool_calls ?? []).map(fromCall) : [];
    return { role: message.role, content: typeof message.content === "string" && !calls.length ? message.content : [...fromContent(message.content), ...calls],
      extensions: nativeFields(target, extras(message, ["role", "content", "tool_calls"])) };
  });
  const extra = extras(input, ["messages", "max_tokens", "temperature", "top_p", "top_k", "stop", "random_seed", "n", "tools", "tool_choice",
    "parallel_tool_calls", "reasoning_effort", "response_format", "prompt_cache_key"]);
  const choice = input.tool_choice;
  if (record(choice) && choice.type !== "function") extra.tool_choice = choice;
  const format = input.response_format;
  if (format?.type === "json_schema" && format.json_schema?.description !== undefined) extra.response_format = format;
  if (input.reasoning_effort !== undefined && !efforts.includes(input.reasoning_effort)) unsupported(target, `reasoning effort ${String(input.reasoning_effort)}`);
  let responseFormat: BridgeInput["responseFormat"];
  if (format?.type === "json_schema") {
    if (!record(format.json_schema) || typeof format.json_schema.name !== "string" || !record(format.json_schema.schema)) return unsupported(target, "JSON schema response format without a schema");
    responseFormat = { type: "json-schema", name: format.json_schema.name, schema: format.json_schema.schema,
      ...(format.json_schema.strict !== undefined ? { strict: format.json_schema.strict } : {}) };
  } else if (format) responseFormat = { type: format.type === "json_object" ? "json" : "text" };
  const baseline: BridgeInput = {
    messages,
    ...(input.max_tokens != null ? { maxOutputTokens: input.max_tokens } : {}),
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
    ...(input.top_p != null ? { topP: input.top_p } : {}),
    ...(input.top_k != null ? { topK: input.top_k } : {}),
    ...(input.stop != null ? { stop: typeof input.stop === "string" ? [input.stop] : input.stop } : {}),
    ...(input.random_seed != null ? { seed: input.random_seed } : {}),
    ...(input.n != null ? { candidates: input.n } : {}),
    ...(input.tools ? { tools: input.tools.map((tool): BridgeTool => {
      const fn = record(tool) && tool.type === "function" && record(tool.function) ? tool.function : undefined;
      return fn && typeof fn.name === "string" ? {
        type: "function", name: fn.name, inputSchema: record(fn.parameters) ? fn.parameters : { type: "object" },
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
        extensions: nativeFields(target, extras(fn, ["name", "parameters", "description", "strict"])),
      } : { type: "native", dialect: target, value: tool as Record<string, unknown> };
    }) } : {}),
    ...(typeof choice === "string" ? { toolChoice: choice === "any" ? "required" : choice }
      : record(choice) && choice.type === "function" ? { toolChoice: { name: choice.function.name } } : {}),
    ...(input.parallel_tool_calls != null ? { parallelToolCalls: input.parallel_tool_calls } : {}),
    ...(input.reasoning_effort != null ? { reasoning: { effort: input.reasoning_effort } } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(input.prompt_cache_key ? { cacheKey: input.prompt_cache_key } : {}),
    extensions: nativeFields(target, extra),
  };
  // Apply the same guards to native and canonical callers.
  baselineToMistralInput(baseline);
  return baseline;
}

const finishReasons: Record<string, FinishReason> = { stop: "stop", length: "length", model_length: "context-limit", tool_calls: "tool-calls", error: "unknown" };
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function mistralOutputToBaseline(value: unknown): BridgeOutput {
  if (!record(value) || typeof value.id !== "string" || typeof value.model !== "string" || !Array.isArray(value.choices)
    || (value.created !== undefined && typeof value.created !== "number")) throw new BridgeError("Mistral returned an invalid chat completion");
  const output = value as unknown as MistralOutput;
  const usage = output.usage;
  if (usage !== undefined && (!record(usage) || !tokens(usage.prompt_tokens) || !tokens(usage.completion_tokens) || !tokens(usage.total_tokens))) {
    throw new BridgeError("Mistral returned invalid usage");
  }
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const result: BridgeUsage = {
    inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, totalTokens: usage?.total_tokens ?? null,
    ...(tokens(cached) ? { cachedInputTokens: cached } : {}),
    ...(typeof usage?.service_tier === "string" ? { serviceTier: usage.service_tier } : {}),
    ...(usage ? { extensions: { [target]: { ...usage } } } : {}),
  };
  return {
    id: output.id, model: output.model,
    ...(typeof output.created === "number" ? { createdAt: new Date(output.created * 1000).toISOString() } : {}),
    choices: output.choices.map((choice): BridgeChoice => {
      if (!record(choice) || !record(choice.message) || typeof choice.index !== "number") throw new BridgeError("Mistral returned an invalid choice");
      const message = choice.message;
      const content = [...fromContent(message.content), ...(message.tool_calls ?? []).map(fromCall)];
      return {
        index: choice.index,
        message: { role: "assistant", content, extensions: nativeFields(target, extras(message, ["role", "content", "tool_calls"])) },
        finishReason: finishReasons[String(choice.finish_reason)] ?? "unknown",
        ...(choice.logprobs != null ? { logprobs: choice.logprobs } : {}),
        extensions: nativeFields(target, extras(choice, ["index", "message", "finish_reason", "logprobs"])),
      };
    }),
    usage: result,
    extensions: nativeFields(target, extras(output, ["id", "model", "created", "object", "choices", "usage"])),
  };
}

const nativeFinish: Record<FinishReason, MistralOutput["choices"][number]["finish_reason"]> = {
  "stop": "stop", "length": "length", "tool-calls": "tool_calls", "context-limit": "model_length",
  "refusal": "stop", "content-filter": "stop", "pause": "stop", "unknown": "error",
};

function toResponseChunk(block: ContentBlock): MistralChunk {
  if (block.type === "thinking") return { ...block.extensions?.mistral, type: "thinking", thinking: [{ type: "text", text: block.text }],
    ...(block.signature !== undefined ? { signature: block.signature } : {}) };
  if (block.type === "text") return { ...block.extensions?.mistral, type: "text", text: block.text };
  if (block.type === "native" && block.dialect === target) return block.value as MistralChunk;
  return unsupported(target, `${block.type} response content`);
}

export function baselineToMistralOutput(output: BridgeOutput): MistralOutput {
  const usage = output.usage;
  return {
    ...output.extensions?.mistral, id: output.id, object: "chat.completion", model: output.model,
    created: output.createdAt ? Math.floor(Date.parse(output.createdAt) / 1000) : Math.floor(Date.now() / 1000),
    choices: output.choices.map((choice) => {
      const content = evaluationContentToText(blocks(choice.message), target);
      const calls = content.filter((b) => b.type === "tool-call").map((b): MistralToolCall => ({
        ...b.extensions?.mistral, id: b.id, type: "function", function: { name: b.name, arguments: b.arguments ?? JSON.stringify(b.input) },
      }));
      const rest = content.filter((b) => b.type !== "tool-call");
      // Plain text collapses to Mistral's string form; thinking, native chunks or chunk metadata keep the chunk array.
      const plain = rest.every((b) => b.type === "text" && !Object.keys(b.extensions?.mistral ?? {}).length);
      return {
        ...choice.extensions?.mistral, index: choice.index, finish_reason: nativeFinish[choice.finishReason],
        ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
        message: { ...choice.message.extensions?.mistral, role: "assistant" as const,
          content: plain ? rest.map((b) => (b as { text: string }).text).join("") : rest.map(toResponseChunk),
          ...(calls.length ? { tool_calls: calls } : {}) },
      };
    }),
    ...(usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null ? { usage: {
      ...usage.extensions?.mistral, prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
      ...(usage.cachedInputTokens !== undefined ? { prompt_tokens_details: {
        ...(record(usage.extensions?.mistral?.prompt_tokens_details) ? usage.extensions.mistral.prompt_tokens_details : {}), cached_tokens: usage.cachedInputTokens,
      } } : {}),
    } } : {}),
  };
}

export const mistralDialect = {
  toBaseline: mistralInputToBaseline,
  fromBaseline: baselineToMistralOutput,
} satisfies DialectService<MistralInput, MistralOutput>;
