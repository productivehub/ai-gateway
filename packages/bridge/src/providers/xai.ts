import type { BridgeCost, BridgeModel, BridgeModelCosts, ProviderConfig } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * xAI lists prices in USD cents per 100 million tokens. A per-million rate in cents is that
 * value / 100; it is kept only when it is a whole number of cents (the rest stays in `raw`).
 */
function perMillion(value: unknown): BridgeCost | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value % 100 !== 0) return undefined;
  return { currency: "USD", amount: value / 100 };
}

/** xAI (Grok) through its OpenAI-compatible Chat Completions API, using the `openai` dialect. */
export class XAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super(config, { label: "xAI", apiKeyEnv: "XAI_API_KEY", baseURLEnv: "XAI_BASE_URL", defaultBaseURL: "https://api.x.ai/v1" });
  }

  protected override modelFields(model: Record<string, unknown>): Partial<BridgeModel> {
    const rates: [keyof BridgeModelCosts, unknown][] = [
      ["inputPerMillionTokens", model.prompt_text_token_price],
      ["outputPerMillionTokens", model.completion_text_token_price],
      ["cachedInputPerMillionTokens", model.cached_prompt_text_token_price],
    ];
    const costs: BridgeModelCosts = {};
    for (const [field, value] of rates) {
      const cost = perMillion(value);
      if (cost) costs[field] = cost;
    }
    return {
      ...(typeof model.context_length === "number" && Number.isSafeInteger(model.context_length) ? { maxInputTokens: model.context_length } : {}),
      ...(Object.keys(costs).length ? { costs } : {}),
    };
  }
}
