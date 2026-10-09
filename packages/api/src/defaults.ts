import { env as processEnv } from "node:process";
import {
  createBridge, resolveBuiltInProviderConfig, openaiDialect, anthropicDialect, ollamaDialect, jevDialect,
  type BuiltInProviderConfig,
} from "@productivehub/ai-bridge";
import { createGateway, type Environment, type GatewayOptions } from "./app.js";
import { buildConfiguredProviders, parseGatewayConfig, type GatewayConfig, type GatewayProviderFactories } from "./config.js";

export interface DefaultGatewayOptions extends Omit<GatewayOptions, "bridge" | "keys" | "models"> {
  /** Register hosted providers with keys; local Ollama requires an explicit base URL. */
  providers?: BuiltInProviderConfig;
  config?: GatewayConfig;
  providerFactories?: GatewayProviderFactories;
}

function configFromConnections(connections: BuiltInProviderConfig): GatewayConfig {
  return parseGatewayConfig({ keys: Object.fromEntries(Object.entries(connections).map(([name, connection]) => [name, {
    provider: name, apiKey: connection.apiKey || undefined, baseURL: connection.baseURL, timeoutMs: connection.timeoutMs,
  }])) });
}

/** The config `createDefaultGateway` builds from `env` (and optional `providers`) when given no `config`. */
export function resolveDefaultGatewayConfig(options: { env: Environment; providers?: BuiltInProviderConfig }): GatewayConfig {
  return configFromConnections(resolveBuiltInProviderConfig(options.providers, options.env));
}

/** Opt-in convenience wiring; the core HTTP app accepts arbitrary registries. */
export function createDefaultGateway(options: DefaultGatewayOptions = {}) {
  const env = options.env ?? processEnv;
  if (options.config && options.providers) throw new Error("Supply config or providers, not both");
  const connections = options.config ? {} : resolveBuiltInProviderConfig(options.providers, env);
  const config = options.config ? parseGatewayConfig(options.config) : configFromConnections(connections);
  const configured = buildConfiguredProviders(config, { env, ...(options.providerFactories ? { factories: options.providerFactories } : {}), overrides: Object.fromEntries(Object.entries(connections)) });
  const dialects = { openai: openaiDialect, anthropic: anthropicDialect, ollama: ollamaDialect, jev: jevDialect };
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
