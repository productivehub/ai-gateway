import { env as processEnv } from "node:process";
import {
  createBridge, resolveBuiltInProviderConfig, openaiDialect, anthropicDialect, ollamaDialect,
  type BuiltInProviderConfig,
} from "@productivehub/ai-bridge";
import { createGateway, type GatewayOptions } from "./app.js";
import { buildConfiguredProviders, parseGatewayConfig, type GatewayConfig, type GatewayProviderFactories } from "./config.js";

export interface DefaultGatewayOptions extends Omit<GatewayOptions, "bridge" | "keys" | "models"> {
  /** Register hosted providers with keys; local Ollama requires an explicit base URL. */
  providers?: BuiltInProviderConfig;
  config?: GatewayConfig;
  providerFactories?: GatewayProviderFactories;
}

/** Opt-in convenience wiring; the core HTTP app accepts arbitrary registries. */
export function createDefaultGateway(options: DefaultGatewayOptions = {}) {
  const env = options.env ?? processEnv;
  if (options.config && options.providers) throw new Error("Supply config or providers, not both");
  const connections = options.config ? {} : resolveBuiltInProviderConfig(options.providers, env);
  const config = parseGatewayConfig(options.config ?? { keys: Object.fromEntries(Object.entries(connections).map(([name, connection]) => [name, {
    provider: name, apiKey: connection.apiKey || undefined, baseURL: connection.baseURL, timeoutMs: connection.timeoutMs,
  }])) });
  const configured = buildConfiguredProviders(config, { env, ...(options.providerFactories ? { factories: options.providerFactories } : {}), overrides: Object.fromEntries(Object.entries(connections)) });
  const dialects = { openai: openaiDialect, anthropic: anthropicDialect, ollama: ollamaDialect };
  const bridge = createBridge({
    providers: configured.providers,
    dialects,
  });
  return createGateway({
    ...options, bridge, keys: configured.keys, models: config.models ?? {},
    ...((options.defaultProvider ?? config.defaultKey) !== undefined ? { defaultProvider: options.defaultProvider ?? config.defaultKey! } : {}),
    defaultDialect: (options.defaultDialect ?? config.defaultDialect ?? env.AI_GATEWAY_DEFAULT_DIALECT ?? "bridge") as keyof typeof dialects | "bridge",
    ...((options.maxBodyBytes ?? config.maxBodyBytes) !== undefined ? { maxBodyBytes: options.maxBodyBytes ?? config.maxBodyBytes! } : {}),
  });
}
