import { readFile } from "node:fs/promises";
import { z } from "zod";
import { OpenAIProvider, AnthropicProvider, DeepSeekProvider, JevProvider, OllamaProvider, OllamaCloudProvider, type ProviderAdapter, type ProviderConfig, type ProviderRegistry } from "@productivehub/ai-bridge";
import type { Environment } from "./app.js";

export interface GatewayKeyConfig {
  provider: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  baseURLEnv?: string;
  timeoutMs?: number;
  /** `false` stops this key reading any provider environment variable; it then uses only its own `apiKey`/`baseURL`. */
  inheritEnv?: boolean;
}
export interface GatewayModelRoute { key: string; model: string }
export interface GatewayConfig {
  keys: Record<string, GatewayKeyConfig>;
  models?: Record<string, GatewayModelRoute>;
  defaultKey?: string;
  defaultDialect?: string;
  maxBodyBytes?: number;
  hostname?: string;
  port?: number;
}
/** Public account metadata. Credentials and their environment references are excluded. */
export interface GatewayKeyInfo {
  name: string;
  provider: string;
  baseURL?: string;
  endpoints: Record<string, string>;
}
export interface GatewayProviderFactory {
  create(config: ProviderConfig): ProviderAdapter;
  defaultBaseURL?: string;
  apiKeyEnv?: string;
  baseURLEnv?: string;
  requiresApiKey?: boolean;
  endpoints?: Record<string, string>;
}
export type GatewayProviderFactories = Readonly<Record<string, GatewayProviderFactory>>;
/** Public, credential-free description of a provider the gateway can create. */
export interface GatewayProviderInfo {
  id: string;
  defaultBaseURL: string | null;
  requiresApiKey: boolean;
  /** Operation names (`complete`, `models`, `allowance`), not paths. */
  endpoints: string[];
}
const builtinFactories: GatewayProviderFactories = {
  openai: { create: (config) => new OpenAIProvider(config), defaultBaseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL", requiresApiKey: true, endpoints: { complete: "/chat/completions", models: "/models" } },
  anthropic: { create: (config) => new AnthropicProvider(config), defaultBaseURL: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", baseURLEnv: "ANTHROPIC_BASE_URL", requiresApiKey: true, endpoints: { complete: "/v1/messages", models: "/v1/models" } },
  deepseek: { create: (config) => new DeepSeekProvider(config), defaultBaseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", baseURLEnv: "DEEPSEEK_BASE_URL", requiresApiKey: true, endpoints: { complete: "/chat/completions", models: "/models", allowance: "/user/balance" } },
  jev: { create: (config) => new JevProvider(config), defaultBaseURL: "https://api.typesafe.ai/v1", apiKeyEnv: "TYPESAFE_API_KEY", baseURLEnv: "TYPESAFE_BASE_URL", requiresApiKey: true, endpoints: { complete: "/systemone", models: "/models" } },
  ollama: { create: (config) => new OllamaProvider(config), baseURLEnv: "OLLAMA_BASE_URL", apiKeyEnv: "OLLAMA_API_KEY", endpoints: { complete: "/api/chat", models: "/api/tags" } },
  "ollama-cloud": { create: (config) => new OllamaCloudProvider(config), defaultBaseURL: "https://ollama.com", apiKeyEnv: "OLLAMA_CLOUD_API_KEY", baseURLEnv: "OLLAMA_CLOUD_BASE_URL", requiresApiKey: true, endpoints: { complete: "/api/chat", models: "/api/tags", allowance: "/api/balance" } },
};

function mergeFactories(custom?: GatewayProviderFactories): Record<string, GatewayProviderFactory> {
  const merged: Record<string, GatewayProviderFactory> = { ...builtinFactories };
  for (const [name, factory] of Object.entries(custom ?? {})) merged[name] = { ...builtinFactories[name], ...factory };
  return merged;
}

/** The providers a gateway can create: built-ins merged with any custom factories. */
export function listGatewayProviders(factories?: GatewayProviderFactories): GatewayProviderInfo[] {
  return Object.entries(mergeFactories(factories)).map(([id, factory]) => ({
    id, defaultBaseURL: factory.defaultBaseURL ?? null, requiresApiKey: factory.requiresApiKey === true, endpoints: Object.keys(factory.endpoints ?? {}),
  }));
}

const nonempty = z.string().trim().min(1);
const endpoint = nonempty.refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Use an HTTP(S) base URL without embedded credentials or query parameters");
const keyName = nonempty.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
/** True when `value` is a key name `parseGatewayConfig` accepts as-is (no padding to trim). */
export function isGatewayKeyName(value: string): boolean {
  const result = keyName.safeParse(value);
  return result.success && result.data === value;
}
/** True when `value` is a base URL `parseGatewayConfig` accepts as-is (HTTP(S), no credentials, query or fragment). */
export function isGatewayBaseURL(value: string): boolean {
  const result = endpoint.safeParse(value);
  return result.success && result.data === value;
}
const configSchema = z.strictObject({
  keys: z.record(keyName, z.strictObject({
    provider: nonempty, apiKey: nonempty.optional(), apiKeyEnv: nonempty.optional(), baseURL: endpoint.optional(),
    baseURLEnv: nonempty.optional(), timeoutMs: z.number().int().positive().optional(),
    inheritEnv: z.boolean().optional(),
  }).refine((value) => !(value.apiKey && value.apiKeyEnv), "Choose apiKey or apiKeyEnv")
    .refine((value) => !(value.baseURL && value.baseURLEnv), "Choose baseURL or baseURLEnv")
    .refine((value) => !(value.inheritEnv === false && (value.apiKeyEnv || value.baseURLEnv)), "inheritEnv: false cannot be combined with apiKeyEnv or baseURLEnv")),
  models: z.record(nonempty, z.strictObject({ key: keyName, model: nonempty })).optional(),
  defaultKey: keyName.optional(), defaultDialect: nonempty.optional(), maxBodyBytes: z.number().int().positive().optional(),
  hostname: nonempty.optional(), port: z.number().int().min(0).max(65535).optional(),
});

export function parseGatewayConfig(value: unknown): GatewayConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid AI gateway API config: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const config = result.data as GatewayConfig;
  if (config.defaultKey && !Object.hasOwn(config.keys, config.defaultKey)) throw new Error("defaultKey must reference a configured key");
  for (const [alias, route] of Object.entries(config.models ?? {})) {
    if (!Object.hasOwn(config.keys, route.key)) throw new Error(`Model "${alias}" must reference a configured key`);
    if (/[\u0000-\u001f\u007f]/.test(alias) || /[\u0000-\u001f\u007f]/.test(route.model)) throw new Error("Model names cannot contain control characters");
  }
  return config;
}

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch { throw new Error(`Cannot read AI gateway API config at ${path}`); }
  let value: unknown;
  try { value = JSON.parse(contents) as unknown; }
  catch { throw new Error("AI gateway API config must be valid JSON"); }
  return parseGatewayConfig(value);
}

export function buildConfiguredProviders(config: GatewayConfig, options: {
  env: Environment; factories?: GatewayProviderFactories; overrides?: Readonly<Record<string, ProviderConfig | undefined>>;
}): { providers: ProviderRegistry; keys: GatewayKeyInfo[] } {
  const factories = mergeFactories(options.factories);
  const providers: Record<string, ProviderAdapter> = Object.create(null) as Record<string, ProviderAdapter>;
  const keys: GatewayKeyInfo[] = [];
  for (const [name, key] of Object.entries(config.keys)) {
    if (!Object.hasOwn(factories, key.provider)) throw new Error(`Key "${name}" has an unregistered provider`);
    const factory = factories[key.provider]!;
    const inherit = key.inheritEnv !== false;
    // inheritEnv: false means the key's own apiKey/baseURL only; a host override may still carry fetch/timeoutMs, never a credential or URL.
    const { apiKey: overrideKey, baseURL: _overrideURL, ...overrideRest } = options.overrides?.[name] ?? {};
    const override: Partial<ProviderConfig> = inherit ? { ...options.overrides?.[name] } : overrideRest;
    const keyEnv = inherit ? key.apiKeyEnv ?? factory.apiKeyEnv : undefined;
    let apiKey = (inherit ? overrideKey : undefined) ?? key.apiKey ?? (keyEnv ? options.env[keyEnv] : undefined);
    if (inherit && key.provider === "ollama-cloud" && !key.apiKey && !key.apiKeyEnv && !apiKey?.trim()) apiKey = options.env.OLLAMA_API_KEY;
    if ((factory.requiresApiKey || key.apiKeyEnv) && !apiKey?.trim()) throw new Error(`Key "${name}" requires a configured API key`);
    const urlEnv = inherit ? key.baseURLEnv ?? factory.baseURLEnv : undefined;
    const configuredURL = key.baseURL ?? (urlEnv ? options.env[urlEnv]?.trim() || undefined : undefined);
    if (key.baseURLEnv && !configuredURL) throw new Error(`Key "${name}" requires its configured base URL`);
    let baseURL = configuredURL ?? factory.defaultBaseURL;
    if (key.provider === "ollama" && !baseURL) throw new Error(`Key "${name}" requires baseURL or OLLAMA_BASE_URL`);
    if (baseURL && !endpoint.safeParse(baseURL).success) throw new Error(`Key "${name}" requires a valid base URL without embedded credentials`);
    if (baseURL && ["ollama", "ollama-cloud"].includes(key.provider)) baseURL = baseURL.replace(/\/+$/, "").replace(/\/api$/, "");
    providers[name] = factory.create({ ...override, apiKey: apiKey ?? "", ...(baseURL ? { baseURL } : {}), ...(key.timeoutMs !== undefined ? { timeoutMs: key.timeoutMs } : {}) });
    keys.push({ name, provider: key.provider, ...(baseURL ? { baseURL } : {}), endpoints: baseURL ? Object.fromEntries(Object.entries(factory.endpoints ?? {}).map(([operation, path]) => [operation, `${baseURL.replace(/\/+$/, "")}${path}`])) : {} });
  }
  return { providers, keys };
}
