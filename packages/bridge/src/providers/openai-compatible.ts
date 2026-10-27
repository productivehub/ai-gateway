import { BridgeError } from "../errors.js";
import type { BridgeModel, ProviderConfig, ProviderModelsResponse, ProviderRequest, ProviderResponse } from "../types.js";
import { OpenAIProvider } from "./openai.js";
import { ProviderHttpError } from "./ollama.js";

const present = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;

/**
 * Headers the OpenAI SDK adds from OPENAI_ORG_ID / OPENAI_PROJECT_ID. Stripped so nothing
 * from the OpenAI environment reaches another vendor's endpoint.
 */
const OPENAI_ONLY_HEADERS = ["openai-organization", "openai-project"];

function isolateFetch(base: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of OPENAI_ONLY_HEADERS) headers.delete(name);
    return (base ?? globalThis.fetch)(input, { ...init, headers });
  };
}

export interface OpenAICompatibleVendor {
  /** Provider name used in errors, e.g. "DeepSeek". */
  label: string;
  apiKeyEnv: string;
  baseURLEnv: string;
  defaultBaseURL: string;
}

/**
 * A vendor's OpenAI-compatible Chat Completions API through the OpenAI SDK. It authenticates
 * only with the vendor's key: settings are resolved once here and passed to the parent
 * explicitly, so the parent's OPENAI_API_KEY / OPENAI_BASE_URL fallbacks can never apply.
 */
export abstract class OpenAICompatibleProvider extends OpenAIProvider {
  private readonly key: string | undefined;
  private readonly root: string;
  private readonly http: typeof globalThis.fetch | undefined;
  private readonly timeoutMs: number | undefined;

  protected constructor(config: ProviderConfig, protected readonly vendor: OpenAICompatibleVendor) {
    const key = present(config.apiKey) ?? present(process.env[vendor.apiKeyEnv]);
    const baseURL = present(config.baseURL) ?? present(process.env[vendor.baseURLEnv]) ?? vendor.defaultBaseURL;
    super({
      baseURL, fetch: isolateFetch(config.fetch),
      ...(key ? { apiKey: key } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    });
    this.key = key;
    this.root = baseURL.replace(/\/+$/, "");
    this.http = config.fetch;
    this.timeoutMs = config.timeoutMs;
  }

  protected requireKey(): string {
    if (!this.key) throw new BridgeError(`${this.vendor.label} requires apiKey or ${this.vendor.apiKeyEnv}`);
    return this.key;
  }

  override async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.requireKey();
    return super.complete(req);
  }

  /** GET with the one resolved key/base pair; non-OK is a ProviderHttpError naming the vendor. */
  protected async get(path: string): Promise<unknown> {
    const key = this.requireKey();
    const response = await (this.http ?? globalThis.fetch)(`${this.root}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs ?? 600_000),
    });
    if (!response.ok) throw new ProviderHttpError(response.status, await response.text(), this.vendor.label);
    return response.json();
  }

  /** Vendor-specific canonical fields beyond id, ownedBy and createdAt. */
  protected modelFields(_model: Record<string, unknown>): Partial<BridgeModel> {
    return {};
  }

  /** Own implementation: vendors' /models entries need not carry `created`, which the OpenAI parent requires. */
  override async listModels(): Promise<ProviderModelsResponse> {
    const { label } = this.vendor;
    const raw = await this.get("/models");
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>).data : undefined;
    if (!Array.isArray(data)) throw new BridgeError(`${label} returned an invalid model list`);
    const models = data.map((value: unknown, i): BridgeModel => {
      if (!value || typeof value !== "object") throw new BridgeError(`${label} returned an invalid model at index ${i}`);
      const model = value as Record<string, unknown>;
      if (typeof model.id !== "string" || !model.id) throw new BridgeError(`${label} returned a model without an id at index ${i}`);
      return {
        id: model.id,
        ...(typeof model.owned_by === "string" ? { ownedBy: model.owned_by } : {}),
        ...(typeof model.created === "number" && Number.isFinite(model.created)
          ? { createdAt: new Date(model.created * 1000).toISOString() } : {}),
        ...this.modelFields(model),
        raw: model,
      };
    });
    return { models, raw };
  }
}
