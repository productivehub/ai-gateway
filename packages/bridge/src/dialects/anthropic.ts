import type Anthropic from "@anthropic-ai/sdk";
import { evaluationContentToText } from "../evaluation.js";
import type { AnthropicInput } from "./types.js";
import type { ContentBlock, BridgeInput, BridgeMessage, BridgeOutput, BridgeTool, BridgeUsage } from "../baseline.js";
import { blocks, extras, nativeFields, requestFields, requireAbsent, toolInput, unsupported } from "./shared.js";

type Message = Anthropic.Messages.Message;
type NativeBlock = Anthropic.Messages.ContentBlockParam;
type NativeUsage = Anthropic.Messages.Usage;

function fromBlock(block: NativeBlock | Anthropic.Messages.ContentBlock): ContentBlock {
  const cache = "cache_control" in block && block.cache_control ? { cacheControl: block.cache_control } : {};
  const extensions = nativeFields("anthropic", extras(block, ["type", "text", "source", "thinking", "signature", "data", "id", "name", "input", "tool_use_id", "content", "is_error", "cache_control", "citations"]));
  switch (block.type) {
    case "text": return { type: "text", text: block.text, ...cache, extensions,
      ...(block.citations ? { citations: block.citations } : {}) };
    case "image":
      if (block.source.type === "file") return { type: "native", dialect: "anthropic", value: { ...block } };
      return { type: "image", ...cache, extensions,
      source: block.source.type === "url" ? { type: "url", url: block.source.url }
        : { type: "base64", data: block.source.data, mediaType: block.source.media_type } };
    case "document": {
      if (block.source.type !== "url" && block.source.type !== "base64") return { type: "native", dialect: "anthropic", value: { ...block } };
      return { type: "document", ...cache,
        source: block.source.type === "url" ? { type: "url", url: block.source.url }
          : { type: "base64", data: block.source.data, mediaType: block.source.media_type },
        extensions: nativeFields("anthropic", extras(block, ["type", "source", "cache_control"])) };
    }
    case "thinking": return { type: "thinking", text: block.thinking, signature: block.signature, extensions };
    case "redacted_thinking": return { type: "redacted-thinking", data: block.data, extensions };
    case "tool_use": return { type: "tool-call", id: block.id, name: block.name, input: block.input, ...cache, extensions };
    case "tool_result": return { type: "tool-result", id: block.tool_use_id,
      content: typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => fromBlock(b as NativeBlock)),
      ...(block.is_error !== undefined ? { isError: block.is_error } : {}), ...cache, extensions };
    default: return { type: "native", dialect: "anthropic", value: { ...block } };
  }
}

function fromTool(tool: Anthropic.Messages.ToolUnion): BridgeTool {
  if (!("input_schema" in tool) || (tool.type != null && tool.type !== "custom")) return { type: "native", dialect: "anthropic", value: { ...tool } };
  return { type: "function", name: tool.name, inputSchema: tool.input_schema,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.cache_control ? { cacheControl: tool.cache_control } : {}),
    extensions: nativeFields("anthropic", extras(tool, ["type", "name", "input_schema", "description", "strict", "cache_control"])) };
}

export function anthropicInputToBaseline(input: AnthropicInput): BridgeInput {
  const messages: BridgeMessage[] = [];
  if (input.system !== undefined) messages.push({ role: "system", content: typeof input.system === "string" ? input.system : input.system.map(fromBlock) });
  messages.push(...input.messages.map((message): BridgeMessage => ({
    role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(fromBlock),
    extensions: nativeFields("anthropic", extras(message, ["role", "content"])),
  })));
  const extra = extras(input, ["messages", "system", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "tools", "tool_choice", "thinking", "output_config", "cache_control"]);
  let reasoning: BridgeInput["reasoning"];
  if (input.thinking && input.thinking.type !== "between_tools") {
    reasoning = {
      mode: input.thinking.type,
      ...(input.thinking.type === "enabled" ? { budgetTokens: input.thinking.budget_tokens } : {}),
      ...("display" in input.thinking && input.thinking.display ? { display: input.thinking.display } : {}),
    };
  } else if (input.thinking) extra.thinking = input.thinking;
  if (input.output_config?.effort) reasoning = { ...reasoning, effort: input.output_config.effort };
  const outputExtra = input.output_config ? extras(input.output_config, ["effort", "format"]) : {};
  if (Object.keys(outputExtra).length) extra.output_config = outputExtra;
  return {
    messages, maxOutputTokens: input.max_tokens,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.top_p !== undefined ? { topP: input.top_p } : {}),
    ...(input.top_k !== undefined ? { topK: input.top_k } : {}),
    ...(input.stop_sequences ? { stop: input.stop_sequences } : {}),
    ...(input.tools ? { tools: input.tools.map(fromTool) } : {}),
    ...(input.tool_choice ? {
      toolChoice: input.tool_choice.type === "any" ? "required" as const
        : input.tool_choice.type === "tool" ? { name: input.tool_choice.name } : input.tool_choice.type,
      ...("disable_parallel_tool_use" in input.tool_choice && input.tool_choice.disable_parallel_tool_use !== undefined ? { parallelToolCalls: !input.tool_choice.disable_parallel_tool_use } : {}),
    } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(input.output_config?.format ? { responseFormat: { type: "json-schema" as const, name: "response", schema: input.output_config.format.schema } } : {}),
    ...(input.cache_control ? { cacheControl: input.cache_control } : {}),
    extensions: nativeFields("anthropic", extra),
  };
}

function toBlock(block: ContentBlock): NativeBlock {
  const extra = requestFields(block.extensions, "anthropic");
  const cache = block.cacheControl ? { cache_control: block.cacheControl } : {};
  switch (block.type) {
    case "text": return { ...extra, ...cache, type: "text", text: block.text,
      ...(block.citations ? { citations: block.citations as Anthropic.Messages.TextBlockParam["citations"] & object } : {}) };
    case "image": {
      if (block.detail !== undefined) unsupported("anthropic", "image detail");
      if (block.source.type === "file") return unsupported("anthropic", "image file id");
      if (block.source.type === "url") return { ...extra, ...cache, type: "image", source: { type: "url", url: block.source.url } };
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(block.source.mediaType)) unsupported("anthropic", `image media type ${block.source.mediaType}`);
      return { ...extra, ...cache, type: "image", source: { type: "base64", data: block.source.data,
        media_type: block.source.mediaType as Anthropic.Messages.Base64ImageSource["media_type"] } };
    }
    case "document": {
      if (block.source.type === "file") return unsupported("anthropic", "OpenAI file id");
      if (block.source.type === "url") return { ...extra, ...cache, type: "document", source: { type: "url", url: block.source.url } };
      if (block.source.mediaType === "text/plain") return { ...extra, ...cache, type: "document", source: { type: "text", data: Buffer.from(block.source.data, "base64").toString("utf8"), media_type: "text/plain" } };
      if (block.source.mediaType !== "application/pdf") unsupported("anthropic", `document media type ${block.source.mediaType}`);
      return { ...extra, ...cache, type: "document", source: { type: "base64", data: block.source.data, media_type: "application/pdf" } };
    }
    case "thinking":
      if (!block.signature) return unsupported("anthropic", "thinking replay without a signature");
      return { ...extra, type: "thinking", thinking: block.text, signature: block.signature };
    case "redacted-thinking": return { ...extra, type: "redacted_thinking", data: block.data };
    case "tool-call": {
      const input = toolInput(block.input, block.arguments);
      if (input === null || typeof input !== "object" || Array.isArray(input)) unsupported("anthropic", "non-object tool input");
      return { ...extra, ...cache, type: "tool_use", id: block.id, name: block.name, input };
    }
    case "tool-result": return { ...extra, ...cache, type: "tool_result", tool_use_id: block.id,
      content: typeof block.content === "string" ? block.content : block.content.map((b) => {
        if (!["text", "image", "document", "native"].includes(b.type)) unsupported("anthropic", `${b.type} tool result`);
        return toBlock(b);
      }) as Anthropic.Messages.ToolResultBlockParam["content"] & object,
      ...(block.isError !== undefined ? { is_error: block.isError } : {}) };
    case "refusal": return { type: "text", text: block.text };
    case "native": return block.dialect === "anthropic" ? block.value as unknown as NativeBlock : unsupported("anthropic", `${block.dialect} content block`);
    case "audio": return unsupported("anthropic", "audio input");
    case "boolean": case "choice": case "score": return unsupported("anthropic", `${block.type} input block`);
  }
}

function toTool(tool: BridgeTool): Anthropic.Messages.ToolUnion {
  if (tool.type === "native") return tool.dialect === "anthropic" ? tool.value as unknown as Anthropic.Messages.ToolUnion : unsupported("anthropic", `${tool.dialect} tool`);
  if (tool.inputSchema.type !== "object") return unsupported("anthropic", "non-object tool schema");
  return { ...requestFields(tool.extensions, "anthropic"), name: tool.name,
    input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}) };
}

export function baselineToAnthropicInput(input: BridgeInput): AnthropicInput {
  requireAbsent("anthropic", input, ["cacheKey", "cacheRetention", "seed", "keepAlive", "runtimeOptions"]);
  if (input.candidates !== undefined && input.candidates !== 1) unsupported("anthropic", "multiple candidates");
  const extra = requestFields(input.extensions, "anthropic");
  if (input.reasoning?.mode && input.reasoning.mode !== "enabled" && input.reasoning.budgetTokens !== undefined) unsupported("anthropic", "budgetTokens with non-enabled thinking");
  if (input.reasoning?.mode === "disabled" && input.reasoning.display !== undefined) unsupported("anthropic", "display with disabled thinking");
  const system: Anthropic.Messages.TextBlockParam[] = [];
  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const message of input.messages) {
    const fields = requestFields(message.extensions, "anthropic");
    if (message.name) unsupported("anthropic", "named message");
    if (message.role === "system" || message.role === "developer") {
      for (const block of blocks(message)) {
        if (block.type !== "text") unsupported("anthropic", "non-text system message");
        system.push(toBlock(block) as Anthropic.Messages.TextBlockParam);
      }
    } else {
      const content = blocks(message).map(toBlock);
      const previous = messages.at(-1);
      // Adjacent OpenAI tool messages become one Anthropic user turn.
      if (previous?.role === message.role && Array.isArray(previous.content) && !Object.keys(fields).length) previous.content.push(...content);
      else messages.push({ ...fields, role: message.role, content });
    }
  }
  let thinking: AnthropicInput["thinking"];
  if (input.reasoning?.mode === "adaptive") thinking = { type: "adaptive", ...(input.reasoning.display ? { display: input.reasoning.display } : {}) };
  else if (input.reasoning?.mode === "disabled") thinking = { type: "disabled" };
  else if (input.reasoning?.mode === "enabled" || input.reasoning?.budgetTokens !== undefined) {
    if (input.reasoning.budgetTokens === undefined) unsupported("anthropic", "enabled thinking without budgetTokens");
    thinking = { type: "enabled", budget_tokens: input.reasoning.budgetTokens,
      ...(input.reasoning.display ? { display: input.reasoning.display } : {}) };
  } else if (input.reasoning?.display) unsupported("anthropic", "thinking display without a mode");
  const effort = input.reasoning?.effort;
  if (effort === "none" || effort === "minimal") unsupported("anthropic", `reasoning effort ${effort}`);
  if (input.responseFormat?.type === "json") unsupported("anthropic", "JSON mode without a schema");
  const format = input.responseFormat?.type === "json-schema" ? { type: "json_schema" as const, schema: input.responseFormat.schema } : undefined;
  const choice = input.toolChoice ?? (input.parallelToolCalls !== undefined ? "auto" : undefined);
  return {
    ...extra, messages, max_tokens: input.maxOutputTokens ?? 4096,
    ...(system.length ? { system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.topK !== undefined ? { top_k: input.topK } : {}),
    ...(input.stop ? { stop_sequences: input.stop } : {}),
    ...(input.tools ? { tools: input.tools.map(toTool) } : {}),
    ...(choice ? { tool_choice: {
      ...(typeof choice === "string" ? { type: choice === "required" ? "any" as const : choice } : { type: "tool" as const, name: choice.name }),
      ...(choice !== "none" && input.parallelToolCalls !== undefined ? { disable_parallel_tool_use: !input.parallelToolCalls } : {}),
    } } : {}),
    ...(thinking ? { thinking } : {}),
    ...(format || effort ? { output_config: { ...(extra.output_config as object | undefined), ...(format ? { format } : {}), ...(effort ? { effort } : {}) } } : {}),
    ...(input.cacheControl ? { cache_control: input.cacheControl } : {}),
  };
}

export function anthropicUsageToBaseline(usage: NativeUsage): BridgeUsage {
  const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return {
    inputTokens, outputTokens: usage.output_tokens, totalTokens: inputTokens + usage.output_tokens,
    ...(usage.cache_read_input_tokens != null ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens != null ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
    ...(usage.cache_creation ? { cacheWrites: { fiveMinuteTokens: usage.cache_creation.ephemeral_5m_input_tokens, oneHourTokens: usage.cache_creation.ephemeral_1h_input_tokens } } : {}),
    ...(usage.output_tokens_details ? { reasoningTokens: usage.output_tokens_details.thinking_tokens } : {}),
    ...(usage.service_tier ? { serviceTier: usage.service_tier } : {}),
    ...(usage.inference_geo ? { inferenceGeo: usage.inference_geo } : {}),
    ...(usage.server_tool_use ? { serverToolUsage: { ...usage.server_tool_use } } : {}),
    extensions: { anthropic: { ...usage } },
  };
}

export function baselineToAnthropicUsage(usage: BridgeUsage): NativeUsage {
  if (usage.inputTokens === null || usage.outputTokens === null) return unsupported("anthropic", "unreported token usage (available as null in baseline)");
  return {
    ...usage.extensions?.anthropic,
    cache_creation: usage.cacheWrites ? { ephemeral_5m_input_tokens: usage.cacheWrites.fiveMinuteTokens, ephemeral_1h_input_tokens: usage.cacheWrites.oneHourTokens } : null,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? null, cache_read_input_tokens: usage.cachedInputTokens ?? null,
    inference_geo: usage.inferenceGeo ?? null,
    input_tokens: usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheWriteTokens ?? 0), output_tokens: usage.outputTokens,
    output_tokens_details: usage.reasoningTokens !== undefined ? { thinking_tokens: usage.reasoningTokens } : null,
    server_tool_use: (usage.serverToolUsage ?? null) as NativeUsage["server_tool_use"],
    service_tier: (["standard", "priority", "batch"].includes(usage.serviceTier ?? "") ? usage.serviceTier : null) as NativeUsage["service_tier"],
  };
}

export function anthropicOutputToBaseline(output: Message): BridgeOutput {
  const finishReason = ({ end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool-calls", pause_turn: "pause", refusal: "refusal", model_context_window_exceeded: "context-limit" } as const)[output.stop_reason ?? "end_turn"];
  return {
    id: output.id, model: output.model,
    choices: [{ index: 0, message: { role: "assistant", content: output.content.map(fromBlock) }, finishReason,
      ...(output.stop_sequence !== null ? { stopSequence: output.stop_sequence } : {}),
      extensions: { anthropic: { stop_reason: output.stop_reason } } }],
    usage: anthropicUsageToBaseline(output.usage),
    extensions: nativeFields("anthropic", extras(output, ["id", "model", "type", "role", "content", "stop_reason", "stop_sequence", "usage"])),
  };
}

function outputBlock(block: ContentBlock): Anthropic.Messages.ContentBlock | undefined {
  switch (block.type) {
    case "text": return { ...block.extensions?.anthropic, type: "text", text: block.text,
      citations: (block.citations ?? null) as Anthropic.Messages.TextBlock["citations"] };
    case "thinking": return block.signature ? { ...block.extensions?.anthropic, type: "thinking", thinking: block.text, signature: block.signature } : undefined;
    case "redacted-thinking": return { type: "redacted_thinking", data: block.data };
    case "refusal": return { type: "text", text: block.text, citations: null };
    case "tool-call": return { caller: { type: "direct" }, ...block.extensions?.anthropic, type: "tool_use", id: block.id, name: block.name, input: toolInput(block.input, block.arguments) };
    case "native": return block.dialect === "anthropic" ? block.value as unknown as Anthropic.Messages.ContentBlock : undefined;
    default: return undefined;
  }
}

export function baselineToAnthropicOutput(output: BridgeOutput): Message {
  if (output.choices.length !== 1) return unsupported("anthropic", "multiple response candidates; select a baseline choice first");
  const choice = output.choices[0]!;
  return {
    container: null, diagnostics: null, stop_details: null, ...output.extensions?.anthropic,
    id: output.id, model: output.model, type: "message", role: "assistant",
    content: evaluationContentToText(blocks(choice.message), "anthropic").flatMap((b) => { const projected = outputBlock(b); return projected ? [projected] : []; }),
    stop_reason: (choice.extensions?.anthropic?.stop_reason ?? ({ "stop": choice.stopSequence ? "stop_sequence" : "end_turn", "length": "max_tokens", "tool-calls": "tool_use", "refusal": "refusal", "content-filter": "refusal", "pause": "pause_turn", "context-limit": "model_context_window_exceeded", "unknown": "end_turn" } as const)[choice.finishReason]) as Message["stop_reason"],
    stop_sequence: choice.stopSequence ?? null, usage: baselineToAnthropicUsage(output.usage),
  };
}
