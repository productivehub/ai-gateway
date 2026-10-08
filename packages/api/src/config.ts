import { readFile } from "node:fs/promises";
import { z } from "zod";
import { OpenAIProvider, AnthropicProvider, DeepSeekProvider, OllamaProvider, OllamaCloudProvider, type ProviderAdapter, type ProviderConfig, type ProviderRegistry } from "@productivehub/ai-bridge";
import type { Environment } from "./app.js";

export interface GatewayKeyConfig {
  provider: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  baseURLEnv?: string;
  timeoutMs?: number;
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
const builtinFactories: GatewayProviderFactories = {
  openai: { create: (config) => new OpenAIProvider(config), defaultBaseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL", requiresApiKey: true, endpoints: { complete: "/chat/completions", models: "/models" } },
  anthropic: { create: (config) => new AnthropicProvider(config), defaultBaseURL: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", baseURLEnv: "ANTHROPIC_BASE_URL", requiresApiKey: true, endpoints: { complete: "/v1/messages", models: "/v1/models" } },
  deepseek: { create: (config) => new DeepSeekProvider(config), defaultBaseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", baseURLEnv: "DEEPSEEK_BASE_URL", requiresApiKey: true, endpoints: { complete: "/chat/completions", models: "/models", allowance: "/user/balance" } },
  ollama: { create: (config) => new OllamaProvider(config), baseURLEnv: "OLLAMA_BASE_URL", apiKeyEnv: "OLLAMA_API_KEY", endpoints: { complete: "/api/chat", models: "/api/tags" } },
  "ollama-cloud": { create: (config) => new OllamaCloudProvider(config), defaultBaseURL: "https://ollama.com", apiKeyEnv: "OLLAMA_CLOUD_API_KEY", baseURLEnv: "OLLAMA_CLOUD_BASE_URL", requiresApiKey: true, endpoints: { complete: "/api/chat", models: "/api/tags", allowance: "/api/balance" } },
};

const nonempty = z.string().trim().min(1);
const endpoint = nonempty.refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Use an HTTP(S) base URL without embedded credentials or query parameters");
const keyName = nonempty.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const configSchema = z.strictObject({
  keys: z.record(keyName, z.strictObject({
    provider: nonempty, apiKey: nonempty.optional(), apiKeyEnv: nonempty.optional(), baseURL: endpoint.optional(),
    baseURLEnv: nonempty.optional(), timeoutMs: z.number().int().positive().optional(),
  }).refine((value) => !(value.apiKey && value.apiKeyEnv), "Choose apiKey or apiKeyEnv")
    .refine((value) => !(value.baseURL && value.baseURLEnv), "Choose baseURL or baseURLEnv")),
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
  const factories: Record<string, GatewayProviderFactory> = { ...builtinFactories };
  for (const [name, factory] of Object.entries(options.factories ?? {})) factories[name] = { ...builtinFactories[name], ...factory };
  const providers: Record<string, ProviderAdapter> = Object.create(null) as Record<string, ProviderAdapter>;
  const keys: GatewayKeyInfo[] = [];
  for (const [name, key] of Object.entries(config.keys)) {
    if (!Object.hasOwn(factories, key.provider)) throw new Error(`Key "${name}" has an unregistered provider`);
    const factory = factories[key.provider]!;
    const keyEnv = key.apiKeyEnv ?? factory.apiKeyEnv;
    let apiKey = options.overrides?.[name]?.apiKey ?? key.apiKey ?? (keyEnv ? options.env[keyEnv] : undefined);
    if (key.provider === "ollama-cloud" && !key.apiKey && !key.apiKeyEnv && !apiKey?.trim()) apiKey = options.env.OLLAMA_API_KEY;
    if ((factory.requiresApiKey || key.apiKeyEnv) && !apiKey?.trim()) throw new Error(`Key "${name}" requires a configured API key`);
    const urlEnv = key.baseURLEnv ?? factory.baseURLEnv;
    const configuredURL = key.baseURL ?? (urlEnv ? options.env[urlEnv]?.trim() || undefined : undefined);
    if (key.baseURLEnv && !configuredURL) throw new Error(`Key "${name}" requires its configured base URL`);
    let baseURL = configuredURL ?? factory.defaultBaseURL;
    if (key.provider === "ollama" && !baseURL) throw new Error(`Key "${name}" requires baseURL or OLLAMA_BASE_URL`);
    if (baseURL && !endpoint.safeParse(baseURL).success) throw new Error(`Key "${name}" requires a valid base URL without embedded credentials`);
    if (baseURL && ["ollama", "ollama-cloud"].includes(key.provider)) baseURL = baseURL.replace(/\/+$/, "").replace(/\/api$/, "");
    providers[name] = factory.create({ ...options.overrides?.[name], apiKey: apiKey ?? "", ...(baseURL ? { baseURL } : {}), ...(key.timeoutMs !== undefined ? { timeoutMs: key.timeoutMs } : {}) });
    keys.push({ name, provider: key.provider, ...(baseURL ? { baseURL } : {}), endpoints: baseURL ? Object.fromEntries(Object.entries(factory.endpoints ?? {}).map(([operation, path]) => [operation, `${baseURL.replace(/\/+$/, "")}${path}`])) : {} });
  }
  return { providers, keys };
}
