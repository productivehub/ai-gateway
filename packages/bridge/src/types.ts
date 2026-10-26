/** SDK-free contracts. Provider and dialect names come from injected registries. */
import type { BridgeInput, BridgeOutput, BridgeUsage } from "./baseline.js";

export interface ProviderRequest {
  model: string;
  input: BridgeInput;
}

export interface ProviderResponse<Structured = unknown, Raw = unknown> {
  output: BridgeOutput<Structured>;
  /** Untouched wire response. */
  raw: Raw;
}

/** A monetary amount expressed in the currency's smallest denomination. */
export interface BridgeCost {
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Non-negative integer in minor units: 250 means USD 2.50 when currency is "USD". */
  amount: number;
}

/** Model pricing. Omitted rates are unknown; an amount of zero means free. */
export interface BridgeModelCosts {
  /** Cost per 1,000,000 tokens, rather than per token. */
  inputPerMillionTokens?: BridgeCost;
  outputPerMillionTokens?: BridgeCost;
  cachedInputPerMillionTokens?: BridgeCost;
  cacheWritePerMillionTokens?: BridgeCost;
  /** Cost per request, when a separate request fee applies. */
  perRequest?: BridgeCost;
}

/** A provider-reported model; absent metadata is not inferred. */
export interface BridgeModel {
  id: string;
  name?: string;
  createdAt?: string;
  modifiedAt?: string;
  ownedBy?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  sizeBytes?: number;
  /** Optional pricing metadata, not a calculated charge for a completion. */
  costs?: BridgeModelCosts;
  /** Native model metadata, including capabilities without a canonical equivalent. */
  raw: unknown;
}

export interface ProviderModelsResponse {
  models: BridgeModel[];
  /** Native list payload(s). SDK page/client state must not be included. */
  raw: unknown;
}

export interface ListModelsRequest<P extends string = string> {
  provider: P;
}

export interface BridgeResponseMeta {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface BridgeModelsResponse extends ProviderModelsResponse {
  provider: string;
  meta: BridgeResponseMeta;
}

/** Providers only communicate their API into the bridge baseline. */
export interface ProviderAdapter {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  /** Optional so completion-only custom adapters remain compatible. */
  listModels?(): Promise<ProviderModelsResponse>;
  /** Optional: remaining spend allowance, for providers that expose one. */
  getAllowance?(): Promise<ProviderAllowanceResponse>;
}

/** A response-only dialect needs only fromBaseline; input conversion is optional. */
export interface DialectService<Input = BridgeInput, Output = unknown> {
  toBaseline?(input: Input): BridgeInput;
  fromBaseline(output: BridgeOutput): Output;
}

export type ProviderRegistry = Readonly<Record<string, ProviderAdapter>>;
export type DialectRegistry = Readonly<Record<string, DialectService<never, unknown>>>;
export type DialectInput<T> = T extends { toBaseline(input: infer I): BridgeInput } ? I : never;
export type DialectOutput<T> = T extends { fromBaseline(output: BridgeOutput): infer O } ? O : never;

export interface BridgeCompletionOptions<D extends DialectRegistry = DialectRegistry> {
  /** Output projection, independent of the request's input dialect. */
  outputDialect?: (keyof D & string) | "bridge" | "structured";
  response?: ResponseMode;
}

export type BridgeRequest<P extends string = string, D extends DialectRegistry = DialectRegistry> = BridgeCompletionOptions<D> & (
  | { provider: P; model: string; input: BridgeInput; dialect?: undefined }
  | { [K in keyof D & string]: { provider: P; model: string; dialect: K; input: DialectInput<D[K]> } }[keyof D & string]
);

/** both keeps the response envelope and raw data; output omits raw; raw returns only native data. */
export type ResponseMode = "both" | "output" | "raw";

export interface BridgeOutputResponse<D extends DialectRegistry = DialectRegistry, Output = BridgeOutput> {
  provider: string;
  model: string;
  readonly dialect: string;
  output: Output;
  usage: BridgeUsage;
  /** Bridge-observed timestamps and monotonic elapsed duration. */
  meta: BridgeResponseMeta;
  /** Caller-defined type is a compile-time contract, not runtime schema validation. */
  toDialect<T = unknown>(dialect: "structured"): T;
  /** Native response projection; always converts the original canonical output. */
  toDialect<K extends keyof D & string>(dialect: K): DialectOutput<D[K]>;
}

export interface BridgeResponse<D extends DialectRegistry = DialectRegistry, Output = BridgeOutput, Raw = unknown>
  extends BridgeOutputResponse<D, Output> {
  /** Untouched provider response. */
  raw: Raw;
}

/** Common connection options for built-ins; custom providers may define their own. */
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface BridgeConfig<P extends ProviderRegistry = ProviderRegistry, D extends DialectRegistry = DialectRegistry> {
  providers: P;
  dialects?: D;
}

export interface AllowanceRequest<P extends string = string> {
  provider: P;
}

/** One quota bucket, flattened so every provider renders the same way. */
export interface AllowanceWindow {
  /** Stable per-provider id: "balance" | "included" | "purchased" | "session" | "daily" | "weekly" | "monthly" | provider-specific. */
  id: string;
  /** money = a balance in currency; plan = a share of a subscription window. */
  kind: "money" | "plan";
  /** Human label, e.g. "Included credit", "Weekly (all models)". */
  label?: string;
  /** The window's ceiling: allowance_usd, plan quota. Absent when the provider only reports a balance (DeepSeek). */
  limit?: BridgeCost;
  /** What is still spendable. Absent for plan windows that report only a percentage. */
  remaining?: BridgeCost;
  /** What has been consumed in this window, when reported. */
  used?: BridgeCost;
  /** 0..1 share still available. remaining/limit, or 1 - utilisation for plan windows; null when it cannot be computed (no limit). */
  remainingFraction: number | null;
  /** The window's current period. resetsAt is the next reset; from/until when the provider reports both. */
  period?: { from?: string; until?: string; resetsAt?: string };
  /** Native window payload. */
  raw?: unknown;
}

/** Consumed usage over a report window, when the provider has a usage endpoint. */
export interface AllowanceUsage {
  from: string;
  until: string;
  requests?: number;
  cost?: BridgeCost;
  tokens?: Pick<BridgeUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">;
  /** Optional time buckets in the same shape, for charts; partial marks an in-progress bucket. */
  buckets?: Array<Omit<AllowanceUsage, "buckets"> & { partial?: boolean }>;
}

export interface ProviderAllowanceResponse {
  /** Provider's own verdict that calls will succeed (DeepSeek is_available); null when it has no such flag. */
  available: boolean | null;
  /** The window to show first: the included/plan balance that actually gates calls. */
  primary: AllowanceWindow | null;
  windows: AllowanceWindow[];
  usage?: AllowanceUsage;
  /** Native payload(s) of every endpoint read. */
  raw: unknown;
}

export interface BridgeAllowanceResponse extends ProviderAllowanceResponse {
  provider: string;
  meta: BridgeResponseMeta;
}
