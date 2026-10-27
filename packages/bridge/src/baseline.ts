/** Provider-neutral, non-streaming messages and evaluations. No SDK types belong here. */
export type WireDialect = string;
export type JSONSchema = Record<string, unknown>;

/** Native fields with no portable equivalent. Only sent to the matching wire API. */
export type NativeFields = Record<WireDialect, Record<string, unknown> | undefined>;

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export type MediaSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string }
  | { type: "file"; id: string };

interface BlockMetadata {
  cacheControl?: CacheControl;
  extensions?: NativeFields;
}

/** Provider-neutral evaluation answers; probabilities and confidence are in [0, 1]. */
export type EvaluationAnswer =
  /** null means no true/false decision was reported; probability still preserves the evaluation. */
  | { type: "boolean"; value: boolean | null; probability?: number }
  | { type: "choice"; value: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; value: number; legend?: Record<string, string>; probabilities?: Record<string, number>; confidence?: number };

/** The ID associates an answer with its question across providers. */
export type EvaluationBlock = BlockMetadata & { id: string } & EvaluationAnswer;

export type ContentBlock = BlockMetadata & (
  | EvaluationBlock
  | { type: "text"; text: string; citations?: unknown[] }
  | { type: "image"; source: MediaSource; detail?: "auto" | "low" | "high" | "original" }
  | { type: "document"; source: MediaSource; name?: string }
  | { type: "audio"; data: string; format: "wav" | "mp3" }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted-thinking"; data: string }
  | { type: "refusal"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown; arguments?: string }
  | { type: "tool-result"; id: string; content: string | ContentBlock[]; isError?: boolean }
  /** Retains new/server-side native blocks without pretending they are portable. */
  | { type: "native"; dialect: WireDialect; value: Record<string, unknown> }
);

export interface BridgeMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | ContentBlock[];
  name?: string;
  extensions?: NativeFields;
}

export type BridgeTool =
  | {
      type: "function";
      name: string;
      description?: string;
      inputSchema: JSONSchema;
      strict?: boolean;
      cacheControl?: CacheControl;
      extensions?: NativeFields;
    }
  | { type: "native"; dialect: WireDialect; value: Record<string, unknown> };

export interface BridgeInput {
  messages: BridgeMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  tools?: BridgeTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  parallelToolCalls?: boolean;
  /** Effort and thinking mode are independent: providers support different controls. */
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    mode?: "adaptive" | "enabled" | "disabled";
    budgetTokens?: number;
    display?: "summarized" | "omitted";
  };
  responseFormat?:
    | { type: "text" }
    | { type: "json" }
    | { type: "json-schema"; name: string; schema: JSONSchema; strict?: boolean };
  cacheControl?: CacheControl;
  cacheKey?: string;
  cacheRetention?: string;
  seed?: number;
  candidates?: number;
  /** Ollama model residency, independent of prompt caching. */
  keepAlive?: string | number;
  /** Ollama runtime settings, e.g. num_ctx / num_gpu. */
  runtimeOptions?: Record<string, unknown>;
  extensions?: NativeFields;
}

export interface BridgeUsage {
  /** Inclusive counts; null means the provider did not report the value. */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWrites?: { fiveMinuteTokens: number; oneHourTokens: number };
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
  serviceTier?: string;
  inferenceGeo?: string;
  serverToolUsage?: Record<string, unknown>;
  /** Ollama native durations converted from nanoseconds to milliseconds. */
  timings?: { totalMs?: number; loadMs?: number; promptMs?: number; generationMs?: number };
  extensions?: NativeFields;
}

export type FinishReason =
  | "stop" | "length" | "tool-calls" | "refusal" | "content-filter"
  | "pause" | "context-limit" | "unknown";

export interface BridgeChoice {
  index: number;
  message: BridgeMessage & { role: "assistant" };
  finishReason: FinishReason;
  stopSequence?: string;
  logprobs?: unknown;
  extensions?: NativeFields;
}

export interface BridgeOutput<Structured = unknown> {
  id: string;
  model: string;
  createdAt?: string;
  choices: BridgeChoice[];
  usage: BridgeUsage;
  /** Native structured answer, when the provider returns data rather than chat text. */
  structured?: Structured;
  extensions?: NativeFields;
}
