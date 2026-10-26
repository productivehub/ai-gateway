/** Built-ins are opt-in; the bridge core has no provider registry or SDK imports. */
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider, OllamaCloudProvider } from "./ollama.js";
import { DeepSeekProvider } from "./deepseek.js";
import { MistralProvider } from "./mistral.js";
import { XAIProvider } from "./xai.js";
import { PerplexityProvider } from "./perplexity.js";
import { JevProvider } from "./jev.js";
import type { ProviderConfig } from "../types.js";

export { OpenAIProvider, AnthropicProvider, DeepSeekProvider, MistralProvider, XAIProvider, JevProvider, PerplexityProvider, OllamaProvider, OllamaCloudProvider };
export { OpenAICompatibleProvider, type OpenAICompatibleVendor } from "./openai-compatible.js";
export { ProviderHttpError } from "./ollama.js";

export interface BuiltInProviderConfig {
  openai?: ProviderConfig;
  anthropic?: ProviderConfig;
  deepseek?: ProviderConfig;
  mistral?: ProviderConfig;
  xai?: ProviderConfig;
  jev?: ProviderConfig;
  perplexity?: ProviderConfig;
  ollama?: ProviderConfig;
  "ollama-cloud"?: ProviderConfig;
}

export type BuiltInProviders = {
  openai?: OpenAIProvider;
  anthropic?: AnthropicProvider;
  deepseek?: DeepSeekProvider;
  mistral?: MistralProvider;
  xai?: XAIProvider;
  jev?: JevProvider;
  perplexity?: PerplexityProvider;
  ollama?: OllamaProvider;
  "ollama-cloud"?: OllamaCloudProvider;
};

function configured(explicit: string | undefined, fallback: string | undefined): string | undefined {
  const value = explicit ?? fallback;
  return value?.trim() ? value : undefined;
}

/** Register only configured providers. Connection settings are captured at startup. */
export function resolveBuiltInProviderConfig(
  config: BuiltInProviderConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): BuiltInProviderConfig {
  const providers: BuiltInProviderConfig = {};
  const openaiKey = configured(config.openai?.apiKey, env.OPENAI_API_KEY);
  if (openaiKey) providers.openai = {
    ...config.openai, apiKey: openaiKey,
    baseURL: configured(config.openai?.baseURL, env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
  };
  const anthropicKey = configured(config.anthropic?.apiKey, env.ANTHROPIC_API_KEY);
  if (anthropicKey) providers.anthropic = {
    ...config.anthropic, apiKey: anthropicKey,
    baseURL: configured(config.anthropic?.baseURL, env.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
  };
  const deepseekKey = configured(config.deepseek?.apiKey, env.DEEPSEEK_API_KEY);
  if (deepseekKey) providers.deepseek = {
    ...config.deepseek, apiKey: deepseekKey,
    baseURL: configured(config.deepseek?.baseURL, env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com",
  };
  const mistralKey = configured(config.mistral?.apiKey, env.MISTRAL_API_KEY);
  if (mistralKey) providers.mistral = {
    ...config.mistral, apiKey: mistralKey,
    baseURL: configured(config.mistral?.baseURL, env.MISTRAL_BASE_URL) ?? "https://api.mistral.ai/v1",
  };
  const xaiKey = configured(config.xai?.apiKey, env.XAI_API_KEY);
  if (xaiKey) providers.xai = {
    ...config.xai, apiKey: xaiKey,
    baseURL: configured(config.xai?.baseURL, env.XAI_BASE_URL) ?? "https://api.x.ai/v1",
  };
  const jevKey = configured(config.jev?.apiKey, env.TYPESAFE_API_KEY);
  if (jevKey) providers.jev = {
    ...config.jev, apiKey: jevKey,
    baseURL: configured(config.jev?.baseURL, env.TYPESAFE_BASE_URL) ?? "https://api.typesafe.ai/v1",
  };
  const perplexityKey = configured(config.perplexity?.apiKey, env.PERPLEXITY_API_KEY);
  if (perplexityKey) providers.perplexity = {
    ...config.perplexity, apiKey: perplexityKey,
    baseURL: configured(config.perplexity?.baseURL, env.PERPLEXITY_BASE_URL) ?? "https://api.perplexity.ai/v1",
  };
  const ollamaURL = configured(config.ollama?.baseURL, env.OLLAMA_BASE_URL);
  if (ollamaURL) providers.ollama = {
    ...config.ollama, baseURL: ollamaURL,
    apiKey: configured(config.ollama?.apiKey, env.OLLAMA_API_KEY) ?? "",
  };
  const cloudKey = configured(config["ollama-cloud"]?.apiKey, configured(env.OLLAMA_CLOUD_API_KEY, undefined) ?? configured(env.OLLAMA_API_KEY, undefined));
  if (cloudKey) providers["ollama-cloud"] = {
    ...config["ollama-cloud"], apiKey: cloudKey,
    baseURL: configured(config["ollama-cloud"]?.baseURL, env.OLLAMA_CLOUD_BASE_URL) ?? "https://ollama.com",
  };
  return providers;
}

/** Create only providers enabled by explicit settings or the supplied environment. */
export function createBuiltInProviders(
  config: BuiltInProviderConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): BuiltInProviders {
  const settings = resolveBuiltInProviderConfig(config, env);
  return {
    ...(settings.openai ? { openai: new OpenAIProvider(settings.openai) } : {}),
    ...(settings.anthropic ? { anthropic: new AnthropicProvider(settings.anthropic) } : {}),
    ...(settings.deepseek ? { deepseek: new DeepSeekProvider(settings.deepseek) } : {}),
    ...(settings.mistral ? { mistral: new MistralProvider(settings.mistral) } : {}),
    ...(settings.xai ? { xai: new XAIProvider(settings.xai) } : {}),
    ...(settings.jev ? { jev: new JevProvider(settings.jev) } : {}),
    ...(settings.perplexity ? { perplexity: new PerplexityProvider(settings.perplexity) } : {}),
    ...(settings.ollama ? { ollama: new OllamaProvider(settings.ollama) } : {}),
    ...(settings["ollama-cloud"] ? { "ollama-cloud": new OllamaCloudProvider(settings["ollama-cloud"]) } : {}),
  };
}
