import { env as processEnv } from "node:process";
import { Hono } from "hono";
import {
  UnsupportedFeatureError, UnknownDialectError, UnknownProviderError,
  type DialectRegistry, type ProviderRegistry, type Bridge, type BridgeResponse, type BridgeInput,
} from "@productivehub/ai-bridge";
import { bridgeInputSchema } from "./schema.js";
import type { GatewayKeyInfo, GatewayModelRoute } from "./config.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface GatewayOptions<P extends ProviderRegistry = ProviderRegistry, D extends DialectRegistry = DialectRegistry> {
  bridge: Bridge<P, D>;
  keys?: readonly GatewayKeyInfo[];
  models?: Readonly<Record<string, GatewayModelRoute>>;
  defaultProvider?: keyof P & string;
  defaultDialect?: (keyof D & string) | "bridge";
  env?: Environment;
  maxBodyBytes?: number;
  /** Host logging receives the original error; responses never expose SDK payloads. */
  onError?: (error: Error) => void;
}

/** Serialized BridgeResponse: output follows dialect, usage remains canonical. */
export interface GatewayResponse<Output = unknown> {
  provider: string;
  key: string;
  model: string;
  dialect: string;
  output: Output;
  usage: BridgeResponse["usage"];
  raw: unknown;
  meta: BridgeResponse["meta"];
}

type ErrorStatus = 400 | 406 | 413 | 415 | 422 | 429 | 500 | 502 | 504;
class ApiError extends Error {
  constructor(readonly status: ErrorStatus, message: string) { super(message); }
}

export function integerSetting(value: string | number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === "number" ? value : (/^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json" && !type?.match(/^application\/[\w.+-]+\+json$/)) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "JSON body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ApiError(400, "Invalid JSON body"); }
}

function selected(query: URLSearchParams, name: string, fallback: string | undefined): string {
  const values = query.getAll(name);
  if (values.length > 1 || (values.length === 1 && !values[0]?.trim())) throw new ApiError(400, `Supply one nonempty ${name}`);
  const value = values[0] ?? fallback;
  if (!value) throw new ApiError(400, `Supply ${name} or configure a default ${name}`);
  return value;
}

/** Fetch app only: safe to mount in a host without starting a server. */
export function createGateway<const P extends ProviderRegistry, const D extends DialectRegistry>(options: GatewayOptions<P, D>) {
  const env = options.env ?? processEnv;
  const { bridge } = options;
  const providers = bridge.providers();
  const dialects = bridge.dialects();
  const suppliedKeys = new Map(options.keys?.map((key) => [key.name, key]));
  const keys = providers.map((name): GatewayKeyInfo => {
    const info = suppliedKeys.get(name);
    return { name, provider: info?.provider ?? name, ...(info?.baseURL ? { baseURL: info.baseURL } : {}), endpoints: { ...info?.endpoints } };
  });
  const models = new Map(Object.entries(options.models ?? {}).map(([name, route]) => [name, { ...route }]));
  for (const route of models.values()) if (!providers.includes(route.key)) throw new Error("Model route must reference a registered key");
  const defaultProvider = options.defaultProvider ?? (env.AI_GATEWAY_DEFAULT_PROVIDER?.trim() || undefined) ?? (providers.length === 1 ? providers[0] : undefined);
  const defaultDialect = options.defaultDialect ?? env.AI_GATEWAY_DEFAULT_DIALECT ?? "bridge";
  if (defaultProvider !== undefined && !providers.includes(defaultProvider)) throw new Error("Configure a registered defaultProvider or AI_GATEWAY_DEFAULT_PROVIDER");
  if (!dialects.includes(defaultDialect)) throw new Error("Configure a registered defaultDialect or AI_GATEWAY_DEFAULT_DIALECT");
  const maxBodyBytes = integerSetting(options.maxBodyBytes ?? env.AI_GATEWAY_MAX_BODY_BYTES ?? 16 * 1024 * 1024, "maxBodyBytes", 1);
  const app = new Hono();

  function chooseKey(query: URLSearchParams, routeKey?: string): GatewayKeyInfo {
    const key = query.has("key") ? selected(query, "key", undefined) : undefined;
    const provider = query.has("provider") ? selected(query, "provider", undefined) : undefined;
    let selectedKey: GatewayKeyInfo | undefined;
    if (key || routeKey) selectedKey = keys.find((info) => info.name === (key ?? routeKey));
    else if (provider) {
      selectedKey = keys.find((info) => info.name === provider);
      if (!selectedKey) {
        const matches = keys.filter((info) => info.provider === provider);
        if (matches.length > 1) throw new ApiError(400, "Multiple keys match this provider; specify key");
        selectedKey = matches[0];
      }
    } else selectedKey = keys.find((info) => info.name === defaultProvider);
    if (!selectedKey) {
      if (key) throw new ApiError(400, "Unknown key");
      if (provider) throw new UnknownProviderError(provider);
      throw new ApiError(400, keys.length ? "Supply key or provider, or configure a default key" : "No providers are configured");
    }
    if (routeKey && selectedKey.name !== routeKey) throw new ApiError(400, "This model alias is configured for another key");
    if (provider && provider !== selectedKey.name && provider !== selectedKey.provider) throw new ApiError(400, "Key does not match provider");
    return selectedKey;
  }

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/keys", (c) => c.json({ keys }));
  app.get("/models/configured", (c) => c.json({ models: [...models].map(([name, route]) => ({ name, ...route, provider: keys.find((key) => key.name === route.key)!.provider })) }));
  app.get("/models", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const key = chooseKey(query);
    if (query.has("dialect")) throw new ApiError(400, "Model discovery returns canonical metadata; dialect selects completion output only");
    const catalog = await bridge.listModels({ provider: key.name as keyof P & string });
    return c.json({ ...catalog, key: key.name, provider: key.provider });
  });
  app.post("/:model{.+}", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const requestedModel = c.req.param("model");
    const route = models.get(requestedModel);
    const key = chooseKey(query, route?.key);
    const dialect = selected(query, "dialect", defaultDialect);
    if (!dialects.includes(dialect)) throw new UnknownDialectError(dialect);
    const model = route?.model ?? requestedModel;
    if (!model.trim() || /[\u0000-\u001f\u007f]/.test(model)) throw new ApiError(400, "Invalid model name");
    const body = await readJson(c.req.raw, maxBodyBytes);
    const parsed = bridgeInputSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "Body must be canonical BridgeInput; streaming and routing fields are not supported");
    // HTTP names are checked against the injected registries before narrowing.
    const response = await bridge.complete({ provider: key.name as keyof P & string, model, input: parsed.data as BridgeInput });
    let output: unknown;
    try { output = response.toDialect(dialect as (keyof D & string) | "bridge"); }
    catch (error) {
      if (error instanceof UnsupportedFeatureError) throw new ApiError(406, error.message);
      throw error;
    }
    const envelope: GatewayResponse = {
      provider: key.provider, key: key.name, model: response.model, dialect, output,
      usage: response.usage, raw: response.raw, meta: response.meta,
    };
    return c.json(envelope);
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
    if (error instanceof UnknownProviderError || error instanceof UnknownDialectError) return c.json({ error: error.message }, 400);
    if (error instanceof UnsupportedFeatureError) return c.json({ error: error.message }, 422);
    options.onError?.(error);
    const status = "status" in error ? error.status : undefined;
    if (status === 429) return c.json({ error: "Provider rate limit exceeded" }, 429);
    if (error.name === "TimeoutError" || error.name === "APIConnectionTimeoutError" || status === 408 || status === 504) {
      return c.json({ error: "Provider request timed out" }, 504);
    }
    return c.json({ error: "Provider request failed" }, 502);
  });
  return app;
}
