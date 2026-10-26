import { BridgeError } from "../errors.js";
import { baselineToJevInput, jevOutputToBaseline, validateJevOutput } from "../dialects/jev.js";
import type { ProviderAdapter, ProviderConfig, ProviderModelsResponse, ProviderRequest, ProviderResponse } from "../types.js";
import { ProviderHttpError } from "./ollama.js";

/** TypeSafe's System One evaluation API. No SDK dependency or automatic retries. */
export class JevProvider implements ProviderAdapter {
  private readonly config: ProviderConfig;
  constructor(config: ProviderConfig = {}) {
    this.config = {
      ...config,
      apiKey: config.apiKey ?? process.env.TYPESAFE_API_KEY ?? "",
      baseURL: config.baseURL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1",
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const { apiKey, baseURL, fetch, timeoutMs } = this.config;
    if (!apiKey?.trim()) throw new BridgeError("Jev requires apiKey or TYPESAFE_API_KEY");
    const response = await (fetch ?? globalThis.fetch)(`${baseURL!.replace(/\/+$/, "")}${path}`, {
      ...init, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs ?? 600_000),
    });
    if (!response.ok) throw new ProviderHttpError(response.status, await response.text(), "Jev");
    return response.json();
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToJevInput(req.input);
    const raw = await this.request("/systemone", { method: "POST", body: JSON.stringify({ ...input, model: req.model }) });
    validateJevOutput(raw);
    if (Object.keys(raw.answers).length !== Object.keys(input.questions).length
      || Object.entries(input.questions).some(([id, question]) => !Object.hasOwn(raw.answers, id) || raw.answers[id]!.type !== question.type)) {
      throw new BridgeError("Jev returned answers that do not match the questions");
    }
    return { output: jevOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const raw = await this.request("/models", { method: "GET" });
    if (!raw || typeof raw !== "object" || !("models" in raw) || !Array.isArray(raw.models)) throw new BridgeError("Jev returned an invalid model list");
    const models = raw.models.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Jev returned an invalid model");
      const model = value as Record<string, unknown>;
      if (typeof model.name !== "string" || !model.name) throw new BridgeError("Jev returned a model without a name");
      return { id: model.name, name: model.name,
        ...(typeof model.release_date === "string" ? { createdAt: model.release_date } : {}), raw: model };
    });
    return { models, raw };
  }
}
