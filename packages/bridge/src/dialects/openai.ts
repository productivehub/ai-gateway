import type OpenAI from "openai";
import { evaluationContentToText } from "../evaluation.js";
import type { OpenAIInput } from "./types.js";
import type {
  ContentBlock, NativeFields, BridgeChoice, BridgeInput, BridgeMessage,
  BridgeOutput, BridgeTool, BridgeUsage, FinishReason,
} from "../baseline.js";
import { blocks, extras, nativeFields, parseArguments, requestFields, requireAbsent, unsupported } from "./shared.js";

type Chat = OpenAI.Chat.Completions.ChatCompletion;
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Part = OpenAI.Chat.Completions.ChatCompletionContentPart;
type Usage = OpenAI.Completions.CompletionUsage;

function fromPart(part: Part | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal): ContentBlock {
  const extensions = nativeFields("openai", extras(part, ["type", "text", "image_url", "input_audio", "refusal"]));
  switch (part.type) {
    case "text": return { type: "text", text: part.text, extensions };
    case "refusal": return { type: "refusal", text: part.refusal, extensions };
    case "image_url": {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
      return {
        type: "image",
        source: match ? { type: "base64", mediaType: match[1]!, data: match[2]! } : { type: "url", url: part.image_url.url },
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
        extensions: nativeFields("openai", { ...extras(part, ["type", "image_url"]), ...extras(part.image_url, ["url", "detail"]) }),
      };
    }
    case "input_audio": return { type: "audio", ...part.input_audio, extensions };
    case "file": return { type: "native", dialect: "openai", value: { ...part } };
  }
}

function fromMessage(message: Message): BridgeMessage {
  if (message.role === "function") return {
    role: "user", content: [{ type: "native", dialect: "openai", value: { ...message } }],
  };
  if (message.role === "tool") return {
    role: "user", content: [{
      type: "tool-result", id: message.tool_call_id,
      content: typeof message.content === "string" ? message.content : message.content.map(fromPart),
      extensions: nativeFields("openai", extras(message, ["role", "content", "tool_call_id"])),
    }],
  };
  const content: ContentBlock[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : (message.content ?? []).map(fromPart);
  if (message.role === "assistant") {
    if (message.refusal) content.push({ type: "refusal", text: message.refusal });
    for (const call of message.tool_calls ?? []) {
      content.push(call.type === "function" ? {
        type: "tool-call", id: call.id, name: call.function.name,
        input: parseArguments(call.function.arguments), arguments: call.function.arguments,
        extensions: nativeFields("openai", extras(call, ["type", "id", "function"])),
      } : { type: "native", dialect: "openai", value: { ...call } });
    }
  }
  return {
    role: message.role, content,
    ...("name" in message && message.name ? { name: message.name } : {}),
    extensions: nativeFields("openai", extras(message, ["role", "content", "name", "tool_calls", "refusal"])),
  };
}

const inputKeys = ["messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "response_format", "seed", "n", "prompt_cache_key", "prompt_cache_retention"];

export function openAIInputToBaseline(input: OpenAIInput): BridgeInput {
  const tools: BridgeTool[] | undefined = input.tools?.map((tool) => tool.type === "function" ? {
    type: "function", name: tool.function.name, inputSchema: tool.function.parameters ?? { type: "object" },
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
    extensions: nativeFields("openai", extras(tool.function, ["name", "parameters", "description", "strict"])),
  } : { type: "native", dialect: "openai", value: { ...tool } });
  let toolChoice: BridgeInput["toolChoice"];
  const extra = extras(input, inputKeys);
  if (input.max_tokens != null) extra.max_tokens = input.max_tokens;
  if (typeof input.tool_choice === "string") toolChoice = input.tool_choice;
  else if (input.tool_choice?.type === "function") toolChoice = { name: input.tool_choice.function.name };
  else if (input.tool_choice) extra.tool_choice = input.tool_choice;
  let responseFormat: BridgeInput["responseFormat"];
  if (input.response_format?.type === "json_schema") {
    const format = input.response_format.json_schema;
    if (!format.schema) return unsupported("bridge", "JSON schema response format without a schema");
    responseFormat = { type: "json-schema", name: format.name, schema: format.schema,
      ...(format.strict != null ? { strict: format.strict } : {}) };
    if (format.description) extra.response_format = input.response_format;
  } else if (input.response_format) responseFormat = { type: input.response_format.type === "json_object" ? "json" : "text" };
  return {
    messages: input.messages.map(fromMessage),
    ...(input.max_completion_tokens != null || input.max_tokens != null ? { maxOutputTokens: input.max_completion_tokens ?? input.max_tokens! } : {}),
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
    ...(input.top_p != null ? { topP: input.top_p } : {}),
    ...(input.stop != null ? { stop: typeof input.stop === "string" ? [input.stop] : input.stop } : {}),
    ...(tools ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}),
    ...(input.parallel_tool_calls !== undefined ? { parallelToolCalls: input.parallel_tool_calls } : {}),
    ...(input.reasoning_effort ? { reasoning: { effort: input.reasoning_effort } } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(input.seed != null ? { seed: input.seed } : {}),
    ...(input.n != null ? { candidates: input.n } : {}),
    ...(input.prompt_cache_key ? { cacheKey: input.prompt_cache_key } : {}),
    ...(input.prompt_cache_retention ? { cacheRetention: input.prompt_cache_retention } : {}),
    extensions: nativeFields("openai", extra),
  };
}

function toPart(block: ContentBlock): Part {
  if (block.cacheControl) unsupported("openai", "content cacheControl");
  const extra = requestFields(block.extensions, "openai");
  switch (block.type) {
    case "text":
      if (block.citations?.length) unsupported("openai", "input citations");
      return { ...extra, type: "text", text: block.text };
    case "image": {
      if (block.source.type === "file") return unsupported("openai", "image file id");
      const url = block.source.type === "url" ? block.source.url : `data:${block.source.mediaType};base64,${block.source.data}`;
      // New SDKs add "original"; keep the baseline compatible with earlier SDK types.
      return { ...extra, type: "image_url", image_url: { url, ...(block.detail ? {
        detail: block.detail as OpenAI.Chat.Completions.ChatCompletionContentPartImage["image_url"]["detail"] & string,
      } : {}) } };
    }
    case "audio": return { ...extra, type: "input_audio", input_audio: { data: block.data, format: block.format } };
    case "document": {
      if (block.source.type === "url") return unsupported("openai", "document URL");
      if (block.source.type === "base64" && block.source.mediaType !== "application/pdf") return unsupported("openai", `document media type ${block.source.mediaType}`);
      return { ...extra, type: "file", file: block.source.type === "file"
        ? { file_id: block.source.id }
        : { file_data: `data:${block.source.mediaType};base64,${block.source.data}`, filename: block.name ?? "document.pdf" } };
    }
    case "native": return block.dialect === "openai" ? block.value as unknown as Part : unsupported("openai", `${block.dialect} content block`);
    default: return unsupported("openai", `${block.type} content block`);
  }
}

function toMessages(message: BridgeMessage): Message[] {
  const content = blocks(message);
  const extra = requestFields(message.extensions, "openai");
  const name = message.name ? { name: message.name } : {};
  if (message.role === "system" || message.role === "developer") {
    return [{ ...extra, ...name, role: message.role, content: content.map((b) => {
      if (b.type !== "text") return unsupported("openai", `${b.type} system content`);
      return toPart(b) as OpenAI.Chat.Completions.ChatCompletionContentPartText;
    }) }];
  }
  if (message.role === "assistant") {
    const text: OpenAI.Chat.Completions.ChatCompletionContentPartText[] = [];
    const calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    let refusal: string | undefined;
    for (const block of content) {
      if (block.cacheControl) unsupported("openai", "content cacheControl");
      const fields = requestFields(block.extensions, "openai");
      if (block.type === "text") {
        if (block.citations?.length) unsupported("openai", "input citations");
        text.push({ ...fields, type: "text", text: block.text });
      }
      else if (block.type === "refusal") refusal = (refusal ?? "") + block.text;
      else if (block.type === "tool-call") calls.push({ ...fields, id: block.id, type: "function", function: { name: block.name, arguments: block.arguments ?? JSON.stringify(block.input) } });
      else if (block.type === "native" && block.dialect === "openai") calls.push(block.value as unknown as OpenAI.Chat.Completions.ChatCompletionMessageToolCall);
      else unsupported("openai", `${block.type} assistant block`);
    }
    return [{ ...extra, ...name, role: "assistant", content: text.length ? text : null,
      ...(calls.length ? { tool_calls: calls } : {}), ...(refusal !== undefined ? { refusal } : {}) }];
  }
  const messages: Message[] = [];
  let parts: Part[] = [];
  function flush() { if (parts.length) { messages.push({ ...extra, ...name, role: "user", content: parts }); parts = []; } }
  for (const block of content) {
    if (block.type === "tool-result") {
      flush();
      if (block.isError || block.cacheControl) unsupported("openai", "tool-result error/cache metadata");
      const fields = requestFields(block.extensions, "openai");
      messages.push({ ...fields, role: "tool", tool_call_id: block.id,
        content: typeof block.content === "string" ? block.content : block.content.map((b) => {
          if (b.type !== "text") return unsupported("openai", `${b.type} tool result`);
          return toPart(b) as OpenAI.Chat.Completions.ChatCompletionContentPartText;
        }) });
    } else if (block.type === "native" && block.dialect === "openai" && block.value.role) {
      flush(); messages.push(block.value as unknown as Message);
    } else parts.push(toPart(block));
  }
  flush();
  if (!messages.length) messages.push({ ...extra, ...name, role: "user", content: "" });
  return messages;
}

export function baselineToOpenAIInput(input: BridgeInput): OpenAIInput {
  requireAbsent("openai", input, ["topK", "cacheControl", "keepAlive", "runtimeOptions"]);
  if (input.reasoning) requireAbsent("openai", input.reasoning, ["mode", "budgetTokens", "display"]);
  if (input.cacheRetention && !["in_memory", "24h"].includes(input.cacheRetention)) unsupported("openai", `cache retention ${input.cacheRetention}`);
  const extra = requestFields(input.extensions, "openai");
  const tools = input.tools?.map((tool): OpenAI.Chat.Completions.ChatCompletionTool => {
    if (tool.type === "native") return tool.dialect === "openai" ? tool.value as unknown as OpenAI.Chat.Completions.ChatCompletionTool : unsupported("openai", `${tool.dialect} tool`);
    if (tool.cacheControl) unsupported("openai", "tool cacheControl");
    return { type: "function", function: { ...requestFields(tool.extensions, "openai"), name: tool.name, parameters: tool.inputSchema,
      ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
  });
  let responseFormat: OpenAIInput["response_format"];
  if (input.responseFormat?.type === "json-schema") responseFormat = { type: "json_schema", json_schema: {
    ...((extra.response_format as { json_schema?: object } | undefined)?.json_schema),
    name: input.responseFormat.name, schema: input.responseFormat.schema,
    ...(input.responseFormat.strict !== undefined ? { strict: input.responseFormat.strict } : {}),
  } };
  else if (input.responseFormat) responseFormat = { type: input.responseFormat.type === "json" ? "json_object" : "text" };
  return {
    ...extra, messages: input.messages.flatMap(toMessages),
    ...(input.maxOutputTokens !== undefined ? extra.max_tokens !== undefined
      ? { max_tokens: input.maxOutputTokens } : { max_completion_tokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.stop ? { stop: input.stop } : {}), ...(tools ? { tools } : {}),
    ...(input.toolChoice ? { tool_choice: typeof input.toolChoice === "string" ? input.toolChoice : { type: "function" as const, function: { name: input.toolChoice.name } } } : {}),
    ...(input.parallelToolCalls !== undefined ? { parallel_tool_calls: input.parallelToolCalls } : {}),
    ...(input.reasoning?.effort ? { reasoning_effort: input.reasoning.effort as OpenAIInput["reasoning_effort"] & string } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.candidates !== undefined ? { n: input.candidates } : {}),
    ...(input.cacheKey ? { prompt_cache_key: input.cacheKey } : {}),
    ...(input.cacheRetention ? { prompt_cache_retention: input.cacheRetention as "in_memory" | "24h" } : {}),
  };
}

export function openAIUsageToBaseline(usage: Usage | undefined): BridgeUsage {
  const p = usage?.prompt_tokens_details;
  const c = usage?.completion_tokens_details;
  return {
    inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, totalTokens: usage?.total_tokens ?? null,
    ...(p?.cached_tokens !== undefined ? { cachedInputTokens: p.cached_tokens } : {}),
    ...(p?.audio_tokens !== undefined ? { inputAudioTokens: p.audio_tokens } : {}),
    ...(c?.reasoning_tokens !== undefined ? { reasoningTokens: c.reasoning_tokens } : {}),
    ...(c?.audio_tokens !== undefined ? { outputAudioTokens: c.audio_tokens } : {}),
    ...(c?.accepted_prediction_tokens !== undefined ? { acceptedPredictionTokens: c.accepted_prediction_tokens } : {}),
    ...(c?.rejected_prediction_tokens !== undefined ? { rejectedPredictionTokens: c.rejected_prediction_tokens } : {}),
    ...(usage ? { extensions: { openai: { ...usage } } } : {}),
  };
}

export function baselineToOpenAIUsage(usage: BridgeUsage): Usage {
  // SDK types require numbers; do not invent zero usage when the provider omits it.
  if (usage.inputTokens === null || usage.outputTokens === null || usage.totalTokens === null) return unsupported("openai", "unreported token usage (available as null in baseline)");
  return {
    ...usage.extensions?.openai, prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
    prompt_tokens_details: { ...(usage.extensions?.openai?.prompt_tokens_details as object | undefined),
      ...(usage.cachedInputTokens !== undefined ? { cached_tokens: usage.cachedInputTokens } : {}),
      ...(usage.inputAudioTokens !== undefined ? { audio_tokens: usage.inputAudioTokens } : {}) },
    completion_tokens_details: { ...(usage.extensions?.openai?.completion_tokens_details as object | undefined),
      ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
      ...(usage.outputAudioTokens !== undefined ? { audio_tokens: usage.outputAudioTokens } : {}),
      ...(usage.acceptedPredictionTokens !== undefined ? { accepted_prediction_tokens: usage.acceptedPredictionTokens } : {}),
      ...(usage.rejectedPredictionTokens !== undefined ? { rejected_prediction_tokens: usage.rejectedPredictionTokens } : {}) },
  };
}

export function openAIOutputToBaseline(output: Chat): BridgeOutput {
  return {
    id: output.id, model: output.model, createdAt: new Date(output.created * 1000).toISOString(),
    choices: output.choices.map((choice): BridgeChoice => ({
      index: choice.index,
      message: { ...fromMessage({ ...choice.message, role: "assistant" }), role: "assistant" },
      finishReason: ({ stop: "stop", length: "length", tool_calls: "tool-calls", function_call: "tool-calls", content_filter: "content-filter" } as Record<string, FinishReason>)[choice.finish_reason] ?? "unknown",
      logprobs: choice.logprobs,
      extensions: nativeFields("openai", extras(choice, ["index", "message", "finish_reason", "logprobs"])),
    })),
    usage: { ...openAIUsageToBaseline(output.usage), ...(output.service_tier ? { serviceTier: output.service_tier } : {}) },
    extensions: nativeFields("openai", extras(output, ["id", "model", "created", "object", "choices", "usage"])),
  };
}

export function baselineToOpenAIOutput(output: BridgeOutput): Chat {
  return {
    ...output.extensions?.openai, id: output.id, model: output.model, object: "chat.completion",
    created: output.createdAt ? Math.floor(Date.parse(output.createdAt) / 1000) : Math.floor(Date.now() / 1000),
    choices: output.choices.map((choice) => {
      const content = evaluationContentToText(blocks(choice.message), "openai");
      const calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = content.flatMap((b) => b.type === "tool-call" ? [{
        ...b.extensions?.openai, id: b.id, type: "function" as const, function: { name: b.name, arguments: b.arguments ?? JSON.stringify(b.input) },
      }] : b.type === "native" && b.dialect === "openai" && b.value.type === "custom" ? [b.value as unknown as OpenAI.Chat.Completions.ChatCompletionMessageToolCall] : []);
      const refusal = content.filter((b) => b.type === "refusal").map((b) => b.text).join("") || null;
      const text = content.filter((b) => b.type === "text");
      return {
        ...choice.extensions?.openai, index: choice.index,
        finish_reason: ({ "stop": "stop", "length": "length", "tool-calls": "tool_calls", "refusal": "content_filter", "content-filter": "content_filter", "pause": "stop", "context-limit": "length", "unknown": "stop" } as const)[choice.finishReason],
        logprobs: (choice.logprobs ?? null) as Chat["choices"][number]["logprobs"],
        message: { ...choice.message.extensions?.openai, role: "assistant" as const,
          content: text.length ? text.map((b) => b.text).join("") : null,
          refusal, ...(calls.length ? { tool_calls: calls } : {}) },
      };
    }),
    ...(output.usage.inputTokens !== null && output.usage.outputTokens !== null && output.usage.totalTokens !== null ? { usage: baselineToOpenAIUsage(output.usage) } : {}),
  };
}
