import { BridgeError } from "../errors.js";
import { baselineToPerplexityInput, perplexityOutputToBaseline } from "../dialects/perplexity.js";
import type { ProviderAdapter, ProviderConfig, ProviderModelsResponse, ProviderRequest, ProviderResponse } from "../types.js";
import { ProviderHttpError } from "./ollama.js";

/** Perplexity Agent API. Credentials and transport are independent of OpenAI settings. */
export class PerplexityProvider implements ProviderAdapter {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = {
      ...config,
      apiKey: config.apiKey ?? process.env.PERPLEXITY_API_KEY ?? "",
      baseURL: config.baseURL ?? process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai/v1",
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const { apiKey, baseURL, fetch, timeoutMs } = this.config;
    if (!apiKey?.trim()) throw new BridgeError("Perplexity requires apiKey or PERPLEXITY_API_KEY");
    const response = await (fetch ?? globalThis.fetch)(`${baseURL!.replace(/\/+$/, "")}${path}`, {
      ...init, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs ?? 600_000),
    });
    if (!response.ok) throw new ProviderHttpError(response.status, await response.text(), "Perplexity");
    return response.json();
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToPerplexityInput(req.input);
    const raw = await this.request("/agent", { method: "POST", body: JSON.stringify({ ...input, model: req.model, stream: false }) });
    return { output: perplexityOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const raw = await this.request("/models", { method: "GET" });
    if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray(raw.data)) throw new BridgeError("Perplexity returned an invalid model list");
    const models = raw.data.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Perplexity returned an invalid model");
      const model = value as Record<string, unknown>;
      if (typeof model.id !== "string" || !model.id) throw new BridgeError("Perplexity returned a model without an id");
      const date = typeof model.created === "number" && model.created > 0 ? new Date(model.created * 1000) : undefined;
      return { id: model.id,
        ...(typeof model.owned_by === "string" ? { ownedBy: model.owned_by } : {}),
        ...(date && Number.isFinite(date.getTime()) ? { createdAt: date.toISOString() } : {}), raw: model };
    });
    return { models, raw };
  }
}
