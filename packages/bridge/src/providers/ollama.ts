import { BridgeError } from "../errors.js";
import { toMinorUnits } from "../money.js";
import type {
  AllowanceUsage, AllowanceWindow, BridgeCost, ProviderAdapter, ProviderAllowanceResponse, ProviderConfig,
  ProviderModelsResponse, ProviderRequest, ProviderResponse,
} from "../types.js";
import { baselineToOllamaInput, ollamaOutputToBaseline } from "../dialects/ollama.js";
import type { OllamaOutput } from "../dialects/ollama.js";

export class ProviderHttpError extends BridgeError {
  override readonly name = "ProviderHttpError";
  constructor(readonly status: number, readonly body: string, provider = "Ollama") {
    super(`${provider} returned HTTP ${status}`);
  }
}

export class OllamaProvider implements ProviderAdapter {
  private readonly config: ProviderConfig;
  constructor(config: ProviderConfig = {}, private readonly cloud = false) { this.config = { ...config }; }

  protected async request(path: string, init: RequestInit, defaultTimeoutMs = 600_000): Promise<unknown> {
    const config = this.config;
    const baseURL = config.baseURL ?? (this.cloud
      ? process.env.OLLAMA_CLOUD_BASE_URL ?? "https://ollama.com"
      : process.env.OLLAMA_BASE_URL ?? "http://localhost:11434");
    const apiKey = config.apiKey ?? (this.cloud
      ? process.env.OLLAMA_CLOUD_API_KEY ?? process.env.OLLAMA_API_KEY
      : process.env.OLLAMA_API_KEY);
    if (this.cloud && !apiKey) throw new BridgeError("Ollama Cloud requires apiKey, OLLAMA_CLOUD_API_KEY or OLLAMA_API_KEY");
    const root = baseURL.replace(/\/+$/, "").replace(/\/api$/, "");
    const response = await (config.fetch ?? globalThis.fetch)(`${root}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(config.timeoutMs ?? defaultTimeoutMs),
    });
    if (!response.ok) throw new ProviderHttpError(response.status, await response.text());
    const raw: unknown = await response.json();
    if (raw && typeof raw === "object" && "error" in raw && raw.error) throw new BridgeError(`Ollama: ${String(raw.error)}`);
    return raw;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToOllamaInput(req.input);
    const raw = await this.request("/api/chat", {
      method: "POST", body: JSON.stringify({ ...input, model: req.model, stream: false }),
    }) as OllamaOutput;
    if (!raw || !raw.done || !raw.message || typeof raw.model !== "string" || typeof raw.created_at !== "string") {
      throw new BridgeError("Ollama returned an invalid non-streaming chat response");
    }
    return { output: ollamaOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const raw = await this.request("/api/tags", { method: "GET" });
    if (!raw || typeof raw !== "object" || !("models" in raw) || !Array.isArray(raw.models)) {
      throw new BridgeError("Ollama returned an invalid model list");
    }
    const models = raw.models.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new BridgeError("Ollama returned an invalid model");
      const model = value as Record<string, unknown>;
      const id = model.model ?? model.name;
      if (typeof id !== "string" || !id) throw new BridgeError("Ollama returned a model without an id");
      return {
        id, ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(typeof model.modified_at === "string" ? { modifiedAt: model.modified_at } : {}),
        ...(typeof model.size === "number" ? { sizeBytes: model.size } : {}),
        raw: model,
      };
    });
    return { models, raw };
  }
}

const usd = (value: unknown, what: string): BridgeCost => {
  if (typeof value !== "number") throw new BridgeError(`Ollama Cloud ${what} is not a number`);
  return { currency: "USD", amount: toMinorUnits(value) };
};

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError(`Ollama Cloud returned an invalid ${what}`);
  return value as Record<string, unknown>;
};

const count = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BridgeError(`Ollama Cloud ${what} is not a number`);
  return value;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new BridgeError(`Ollama Cloud ${what} is not a string`);
  return value;
};

function usageSlice(value: unknown, what: string): Omit<AllowanceUsage, "buckets"> & { partial?: boolean } {
  const o = record(value, what);
  return {
    from: text(o.from, `${what}.from`),
    until: text(o.until, `${what}.until`),
    ...(o.partial === true ? { partial: true } : {}),
    requests: count(o.request_count, `${what}.request_count`),
    cost: usd(o.usage_usd, `${what}.usage_usd`),
    tokens: {
      inputTokens: count(o.input_tokens, `${what}.input_tokens`),
      outputTokens: count(o.output_tokens, `${what}.output_tokens`),
      cachedInputTokens: count(o.cached_input_tokens, `${what}.cached_input_tokens`),
    },
  };
}

const ALLOWANCE_TIMEOUT_MS = 15_000;
const nonNegative = (value: number): number => Math.max(0, value);

export class OllamaCloudProvider extends OllamaProvider {
  constructor(config: ProviderConfig = {}) { super(config, true); }

  async getAllowance(): Promise<ProviderAllowanceResponse> {
    const get = (path: string) => this.request(path, { method: "GET" }, ALLOWANCE_TIMEOUT_MS);
    // Usage is optional: any transport/HTTP failure drops it, a balance failure still throws.
    const usagePending = get("/api/usage").then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
    const balance = await get("/api/balance");
    const usageResult = await usagePending;
    const b = record(balance, "balance");
    const included = record(b.included, "balance.included");
    const purchased = record(b.purchased, "balance.purchased");
    const period = record(included.period, "balance.included.period");
    const allowanceUsd = nonNegative(count(included.allowance_usd, "allowance_usd"));
    const balanceUsd = nonNegative(count(included.balance_usd, "balance_usd"));
    const includedWindow: AllowanceWindow = {
      id: "included", kind: "money", label: "Included credit",
      limit: usd(allowanceUsd, "allowance_usd"), remaining: usd(balanceUsd, "balance_usd"),
      remainingFraction: allowanceUsd > 0 ? Math.min(1, Math.max(0, balanceUsd / allowanceUsd)) : null,
      period: { from: text(period.from, "period.from"), until: text(period.until, "period.until") },
      raw: included,
    };
    const purchasedWindow: AllowanceWindow = {
      id: "purchased", kind: "money", label: "Purchased credit",
      remaining: usd(nonNegative(count(purchased.balance_usd, "purchased.balance_usd")), "purchased.balance_usd"), remainingFraction: null, raw: purchased,
    };
    const windows = [includedWindow, purchasedWindow];
    if (!usageResult.ok) return { available: null, primary: includedWindow, windows, raw: { balance } };
    const usageRaw = usageResult.value;
    const u = record(usageRaw, "usage");
    const { partial: _partial, ...totals } = usageSlice({ from: u.from, until: u.until, ...record(u.totals, "usage.totals") }, "usage");
    if (!Array.isArray(u.buckets)) throw new BridgeError("Ollama Cloud returned an invalid usage.buckets");
    const usage: AllowanceUsage = { ...totals, buckets: u.buckets.map((x, i) => usageSlice(x, `usage.buckets[${i}]`)) };
    return { available: null, primary: includedWindow, windows, usage, raw: { balance, usage: usageRaw } };
  }
}
