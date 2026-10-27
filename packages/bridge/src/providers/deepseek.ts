import { BridgeError } from "../errors.js";
import { toMinorUnits } from "../money.js";
import type { AllowanceWindow, ProviderAllowanceResponse, ProviderConfig } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** DeepSeek through its OpenAI-compatible API, with its own key, model list and balance read. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super(config, { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", baseURLEnv: "DEEPSEEK_BASE_URL", defaultBaseURL: "https://api.deepseek.com" });
  }

  async getAllowance(): Promise<ProviderAllowanceResponse> {
    const body = await this.get("/user/balance");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("DeepSeek returned an invalid balance response");
    const { is_available: isAvailable, balance_infos: infos } = body as Record<string, unknown>;
    if (!Array.isArray(infos)) throw new BridgeError("DeepSeek returned an invalid balance_infos");
    const entries = infos.map((value, i) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError(`DeepSeek returned an invalid balance_infos[${i}]`);
      const entry = value as Record<string, unknown>;
      const { currency, total_balance: total } = entry;
      if (typeof currency !== "string" || !currency) throw new BridgeError(`DeepSeek balance_infos[${i}].currency is not a string`);
      if (typeof total !== "string" && typeof total !== "number") throw new BridgeError(`DeepSeek balance_infos[${i}].total_balance is not a string`);
      return { entry, currency, amount: toMinorUnits(total) };
    });
    const windows = entries.map(({ entry, currency, amount }): AllowanceWindow => ({
      id: entries.length === 1 ? "balance" : `balance-${currency.toLowerCase()}`,
      kind: "money", label: `Balance (${currency})`,
      remaining: { currency, amount }, remainingFraction: null, raw: entry,
    }));
    return {
      available: typeof isAvailable === "boolean" ? isAvailable : null,
      primary: windows[0] ?? null, windows, raw: body,
    };
  }
}
