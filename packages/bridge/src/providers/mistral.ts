import { BridgeError } from "../errors.js";
import { baselineToMistralInput, mistralOutputToBaseline } from "../dialects/mistral.js";
import type { BridgeModel, ProviderAdapter, ProviderConfig, ProviderModelsResponse, ProviderRequest, ProviderResponse } from "../types.js";
import { ProviderHttpError } from "./ollama.js";

/** Mistral AI (La Plateforme) Chat Completions. No SDK dependency; never reads OpenAI settings. */
export class MistralProvider implements ProviderAdapter {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = {
      ...config,
      apiKey: config.apiKey ?? process.env.MISTRAL_API_KEY ?? "",
      baseURL: config.baseURL ?? process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1",
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const { apiKey, baseURL, fetch, timeoutMs } = this.config;
    if (!apiKey?.trim()) throw new BridgeError("Mistral requires apiKey or MISTRAL_API_KEY");
    const response = await (fetch ?? globalThis.fetch)(`${baseURL!.replace(/\/+$/, "")}${path}`, {
      ...init, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs ?? 600_000),
    });
    if (!response.ok) throw new ProviderHttpError(response.status, await response.text(), "Mistral");
    return response.json();
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToMistralInput(req.input);
    const raw = await this.request("/chat/completions", { method: "POST", body: JSON.stringify({ ...input, model: req.model, stream: false }) });
    return { output: mistralOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const raw = await this.request("/models", { method: "GET" });
    if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray(raw.data)) throw new BridgeError("Mistral returned an invalid model list");
    const models = raw.data.map((value: unknown): BridgeModel => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Mistral returned an invalid model");
      const model = value as Record<string, unknown>;
      if (typeof model.id !== "string" || !model.id) throw new BridgeError("Mistral returned a model without an id");
      const date = typeof model.created === "number" && model.created > 0 ? new Date(model.created * 1000) : undefined;
      return { id: model.id,
        ...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
        ...(typeof model.owned_by === "string" ? { ownedBy: model.owned_by } : {}),
        ...(date && Number.isFinite(date.getTime()) ? { createdAt: date.toISOString() } : {}),
        ...(typeof model.max_context_length === "number" && Number.isSafeInteger(model.max_context_length) ? { maxInputTokens: model.max_context_length } : {}),
        raw: model };
    });
    return { models, raw };
  }
}
