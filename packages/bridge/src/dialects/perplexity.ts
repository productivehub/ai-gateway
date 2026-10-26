import type { BridgeInput, BridgeMessage, BridgeOutput, ContentBlock, JSONSchema } from "../baseline.js";
import type { DialectService } from "../types.js";
import { BridgeError } from "../errors.js";
import { evaluationContentToText } from "../evaluation.js";
import { blocks, extras, nativeFields, parseArguments, requestFields, requireAbsent, unsupported } from "./shared.js";

export interface PerplexityItem { type: string; [key: string]: unknown }
/** The bridge request supplies model; model fallback chains are outside its routing contract. */
export interface PerplexityInput {
  input: string | PerplexityItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: JSONSchema; strict?: boolean; description?: string } };
  tools?: PerplexityItem[];
  tool_choice?: "auto" | "none" | "required" | Record<string, unknown>;
  effort?: string;
  max_steps?: number;
  previous_response_id?: string;
  language_preference?: string;
  store?: boolean;
  [key: string]: unknown;
}
export interface PerplexityOutput {
  id: string;
  model: string;
  object: "response";
  created_at: number;
  status: "completed" | "incomplete" | "failed" | "in_progress" | "queued" | "cancelled";
  output: PerplexityItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number; [key: string]: unknown };
    tool_calls_details?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const target = "perplexity";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fromPart(part: PerplexityItem): ContentBlock {
  if (!record(part) || typeof part.type !== "string") unsupported(target, "invalid content part");
  const extensions = nativeFields(target, extras(part, ["type", "text", "annotations", "image_url"]));
  if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") return {
    type: "text", text: part.text, ...(Array.isArray(part.annotations) ? { citations: part.annotations } : {}), extensions,
  };
  if (part.type === "input_image" && typeof part.image_url === "string") {
    const data = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url);
    return { type: "image", source: data ? { type: "base64", mediaType: data[1]!, data: data[2]! } : { type: "url", url: part.image_url }, extensions };
  }
  return { type: "native", dialect: target, value: part };
}
function fromCall(item: PerplexityItem): ContentBlock {
  if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
    throw new BridgeError("Perplexity returned an invalid function call");
  }
  return { type: "tool-call", id: item.call_id, name: item.name, arguments: item.arguments, input: parseArguments(item.arguments),
    extensions: nativeFields(target, extras(item, ["type", "call_id", "name", "arguments"])) };
}

export function perplexityInputToBaseline(input: PerplexityInput): BridgeInput {
  if (!record(input) || (typeof input.input !== "string" && !Array.isArray(input.input))) unsupported(target, "input must be a string or item array");
  if (input.response_format !== undefined && (!record(input.response_format) || input.response_format.type !== "json_schema"
    || !record(input.response_format.json_schema) || typeof input.response_format.json_schema.name !== "string"
    || !record(input.response_format.json_schema.schema))) unsupported(target, "invalid JSON schema response format");
  const messages: BridgeMessage[] = typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input.map((item) => {
    if (!record(item) || typeof item.type !== "string") return unsupported(target, "invalid input item");
    if (item.type === "message") {
      if (!["system", "developer", "user", "assistant"].includes(String(item.role)) || (typeof item.content !== "string" && !Array.isArray(item.content))) unsupported(target, "invalid input message");
      return { role: item.role as BridgeMessage["role"], content: typeof item.content === "string" ? item.content : (item.content as PerplexityItem[]).map(fromPart),
        extensions: nativeFields(target, extras(item, ["type", "role", "content"])) };
    }
    if (item.type === "function_call") return { role: "assistant", content: [fromCall(item)] };
    if (item.type === "function_call_output" && typeof item.call_id === "string" && (typeof item.output === "string" || Array.isArray(item.output))) return {
      role: "user", content: [{ type: "tool-result", id: item.call_id,
        content: typeof item.output === "string" ? item.output : (item.output as PerplexityItem[]).map(fromPart),
        extensions: nativeFields(target, extras(item, ["type", "call_id", "output"])) }],
    };
    return { role: "user", content: [{ type: "native", dialect: target, value: item }] };
  });
  const extra = extras(input, ["input", "max_output_tokens", "temperature", "top_p", "reasoning", "response_format", "tools", "tool_choice"]);
  const choice = input.tool_choice;
  if (choice && typeof choice !== "string") extra.tool_choice = choice;
  const format = input.response_format?.json_schema;
  if (format?.description !== undefined) extra.response_format = input.response_format;
  const baseline: BridgeInput = {
    messages,
    ...(input.max_output_tokens !== undefined ? { maxOutputTokens: input.max_output_tokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.top_p !== undefined ? { topP: input.top_p } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(format ? { responseFormat: { type: "json-schema", name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}) } as const } : {}),
    ...(typeof choice === "string" ? { toolChoice: choice } : {}),
    ...(input.tools ? { tools: input.tools.map((tool) => tool.type === "function" && typeof tool.name === "string" ? {
      type: "function" as const, name: tool.name, inputSchema: record(tool.parameters) ? tool.parameters : { type: "object" },
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      extensions: nativeFields(target, extras(tool, ["type", "name", "parameters", "description", "strict"])),
    } : { type: "native" as const, dialect: target, value: tool }) } : {}),
    extensions: nativeFields(target, extra),
  };
  // Apply the same synchronous/routing guards to native and canonical callers.
  baselineToPerplexityInput(baseline);
  return baseline;
}

function toPart(block: ContentBlock): PerplexityItem {
  if (block.cacheControl) unsupported(target, "content cacheControl");
  const extra = requestFields(block.extensions, target);
  if (block.type === "text") {
    if (block.citations?.length) unsupported(target, "input citations");
    return { ...extras(extra, ["message"]), type: "input_text", text: block.text };
  }
  if (block.type === "image") {
    if (block.source.type === "file" || block.detail !== undefined) unsupported(target, "image file id or detail");
    return { ...extra, type: "input_image", image_url: block.source.type === "url" ? block.source.url : `data:${block.source.mediaType};base64,${block.source.data}` };
  }
  if (block.type === "document") {
    if (block.source.type === "file") unsupported(target, "document file id");
    return { ...extra, type: "input_file", ...(block.name ? { filename: block.name } : {}),
      ...(block.source.type === "url" ? { file_url: block.source.url } : { file_data: `data:${block.source.mediaType};base64,${block.source.data}` }) };
  }
  if (block.type === "native" && block.dialect === target) return { ...extra, ...block.value } as PerplexityItem;
  return unsupported(target, `${block.type} content block`);
}
function toItems(message: BridgeMessage): PerplexityItem[] {
  requireAbsent(target, message, ["name"]);
  const extra = requestFields(message.extensions, target);
  if (typeof message.content === "string") return [{ ...extra, type: "message", role: message.role, content: message.content }];
  const items: PerplexityItem[] = [];
  let pending: PerplexityItem[] = [];
  const flush = () => {
    if (pending.length) items.push({ ...extra, type: "message", role: message.role, content: pending });
    pending = [];
  };
  for (const block of message.content) {
    if (block.cacheControl) unsupported(target, "content cacheControl");
    const fields = requestFields(block.extensions, target);
    if (block.type === "tool-call" || block.type === "tool-result" || (block.type === "native" && block.dialect === target && !String(block.value.type).startsWith("input_"))) {
      flush();
      if (Object.keys(extra).length) unsupported(target, "message metadata on standalone items");
      if (block.type === "tool-call") {
        if (message.role !== "assistant") unsupported(target, "function call outside assistant message");
        if (block.arguments === undefined && block.input === undefined) unsupported(target, "missing function arguments");
        items.push({ ...fields, type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments ?? JSON.stringify(block.input) });
      } else if (block.type === "tool-result") {
        if (message.role !== "user" || block.isError !== undefined) unsupported(target, "function result role or isError");
        items.push({ ...fields, type: "function_call_output", call_id: block.id, output: typeof block.content === "string" ? block.content : block.content.map(toPart) });
      } else items.push(toPart(block));
    } else pending.push(toPart(block));
  }
  flush();
  if (!message.content.length) items.push({ ...extra, type: "message", role: message.role, content: [] });
  return items;
}

export function baselineToPerplexityInput(input: BridgeInput): PerplexityInput {
  requireAbsent(target, input, ["topK", "stop", "parallelToolCalls", "cacheControl", "cacheKey", "cacheRetention", "seed", "candidates", "keepAlive", "runtimeOptions"]);
  const extra = requestFields(input.extensions, target);
  requireAbsent(target, extra, ["model", "models", "input"]);
  if (extra.stream !== undefined && extra.stream !== false) unsupported(target, "streaming");
  if (extra.background !== undefined && extra.background !== false) unsupported(target, "background execution");
  if (input.reasoning) {
    requireAbsent(target, input.reasoning, ["mode", "budgetTokens", "display"]);
    if (input.reasoning.effort === "none") unsupported(target, "reasoning effort none");
  }
  const format = input.responseFormat;
  if (format && format.type !== "json-schema") unsupported(target, `${format.type} response format`);
  return {
    ...extra, input: input.messages.flatMap(toItems),
    ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning as PerplexityInput["reasoning"] & object } : {}),
    ...(format?.type === "json-schema" ? { response_format: { type: "json_schema" as const, json_schema: {
      ...(record(extra.response_format) && record(extra.response_format.json_schema) ? extra.response_format.json_schema : {}),
      name: format.name, schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}),
    } } } : {}),
    ...(input.tools ? { tools: input.tools.map((tool): PerplexityItem => {
      if (tool.type === "native") return tool.dialect === target ? tool.value as PerplexityItem : unsupported(target, `${tool.dialect} tool`);
      if (tool.cacheControl) unsupported(target, "tool cacheControl");
      return { ...requestFields(tool.extensions, target), type: "function", name: tool.name, parameters: tool.inputSchema,
        ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) };
    }) } : {}),
    ...(input.toolChoice !== undefined ? { tool_choice: typeof input.toolChoice === "string" ? input.toolChoice : { type: "function", name: input.toolChoice.name } } : {}),
  };
}

const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function perplexityOutputToBaseline(value: unknown): BridgeOutput {
  if (!record(value) || typeof value.id !== "string" || typeof value.model !== "string" || value.object !== "response"
    || typeof value.created_at !== "number" || !Number.isFinite(new Date(value.created_at * 1000).getTime()) || !Array.isArray(value.output)
    || !["completed", "incomplete", "failed", "in_progress", "queued", "cancelled"].includes(String(value.status))) throw new BridgeError("Perplexity returned an invalid agent response");
  if (!["completed", "incomplete"].includes(String(value.status))) throw new BridgeError(`Perplexity agent response status: ${String(value.status)}`);
  const output = value as unknown as PerplexityOutput;
  const usage = output.usage;
  if (usage !== undefined && (!record(usage) || !tokens(usage.input_tokens) || !tokens(usage.output_tokens) || !tokens(usage.total_tokens))) throw new BridgeError("Perplexity returned invalid usage");
  const details = usage?.input_tokens_details;
  if (details !== undefined && (!record(details) || [details.cache_read_input_tokens, details.cache_creation_input_tokens].some((v) => v !== undefined && !tokens(v)))) throw new BridgeError("Perplexity returned invalid cache usage");
  const content: ContentBlock[] = output.output.flatMap((item, index): ContentBlock[] => {
    if (!record(item) || typeof item.type !== "string") throw new BridgeError("Perplexity returned an invalid output item");
    if (item.type === "function_call") return [fromCall(item)];
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) throw new BridgeError("Perplexity returned an invalid message");
      // Store message boundaries on parts so several agent messages remain one candidate.
      if (item.content.length) return item.content.map((part: unknown) => {
        if (!record(part) || part.type !== "output_text" || typeof part.text !== "string" || (part.annotations !== undefined && !Array.isArray(part.annotations))) throw new BridgeError("Perplexity returned invalid message content");
        const block = fromPart(part as PerplexityItem);
        block.extensions = { perplexity: { ...block.extensions?.perplexity, message: { index, fields: extras(item, ["content"]) } } };
        return block;
      });
    }
    return [{ type: "native", dialect: target, value: item }];
  });
  return {
    id: output.id, model: output.model, createdAt: new Date(output.created_at * 1000).toISOString(),
    choices: [{ index: 0, message: { role: "assistant", content }, finishReason: output.status === "incomplete" ? "length" : content.some((b) => b.type === "tool-call") ? "tool-calls" : "stop" }],
    usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, totalTokens: usage?.total_tokens ?? null,
      ...(details?.cache_read_input_tokens !== undefined ? { cachedInputTokens: details.cache_read_input_tokens } : {}),
      ...(details?.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: details.cache_creation_input_tokens } : {}),
      ...(usage?.tool_calls_details ? { serverToolUsage: usage.tool_calls_details } : {}),
      extensions: nativeFields(target, usage ? { ...usage } : {}),
    }, extensions: nativeFields(target, extras(output, ["id", "model", "created_at", "object", "output", "usage"])),
  };
}

export function baselineToPerplexityOutput(output: BridgeOutput): PerplexityOutput {
  if (output.choices.length !== 1) unsupported(target, "multiple response candidates");
  const choice = output.choices[0]!;
  const items: PerplexityItem[] = [];
  let lastGroup: unknown;
  for (const block of evaluationContentToText(blocks(choice.message), target)) {
    const fields = block.extensions?.perplexity ?? {};
    if (block.type === "text") {
      const metadata = record(fields.message) ? fields.message : undefined;
      const group = metadata?.index ?? "projected";
      let message = items.at(-1);
      if (group !== lastGroup || message?.type !== "message") {
        message = { id: `${output.id}_message_${items.length}`, type: "message", role: "assistant", status: "completed",
          ...(record(metadata?.fields) ? metadata.fields : {}), content: [] };
        items.push(message);
      }
      (message.content as PerplexityItem[]).push({ ...extras(fields, ["message"]), type: "output_text", text: block.text, ...(block.citations !== undefined ? { annotations: block.citations } : {}) });
      lastGroup = group;
    } else if (block.type === "tool-call") items.push({ id: `${output.id}_call_${items.length}`, status: "completed", ...fields, type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments ?? JSON.stringify(block.input) });
    else if (block.type === "native" && block.dialect === target) items.push(block.value as PerplexityItem);
    else unsupported(target, `${block.type} response content`);
  }
  const usage = output.usage;
  const hasUsage = usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null;
  const nativeUsage = usage.extensions?.perplexity ?? {};
  return {
    ...output.extensions?.perplexity, id: output.id, model: output.model, object: "response",
    created_at: output.createdAt ? Math.floor(Date.parse(output.createdAt) / 1000) : Math.floor(Date.now() / 1000),
    status: choice.finishReason === "length" ? "incomplete" : "completed", output: items,
    ...(hasUsage ? { usage: { ...nativeUsage, input_tokens: usage.inputTokens!, output_tokens: usage.outputTokens!, total_tokens: usage.totalTokens!,
      ...(usage.cachedInputTokens !== undefined || usage.cacheWriteTokens !== undefined ? { input_tokens_details: {
        ...(record(nativeUsage.input_tokens_details) ? nativeUsage.input_tokens_details : {}),
        ...(usage.cachedInputTokens !== undefined ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
      } } : {}), ...(usage.serverToolUsage ? { tool_calls_details: usage.serverToolUsage } : {}),
    } } : {}),
  };
}

export const perplexityDialect = {
  toBaseline: perplexityInputToBaseline,
  fromBaseline: baselineToPerplexityOutput,
} satisfies DialectService<PerplexityInput, PerplexityOutput>;
