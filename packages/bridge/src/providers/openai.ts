import type OpenAI from "openai";
import { BridgeError } from "../errors.js";
import type { ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse, ProviderModelsResponse } from "../types.js";
import { baselineToOpenAIInput, openAIOutputToBaseline } from "../dialects/openai.js";

export class OpenAIProvider implements ProviderAdapter {
  private client: Promise<OpenAI> | undefined;
  private readonly config: ProviderConfig;
  constructor(config: ProviderConfig = {}) { this.config = { ...config }; }

  private getClient(): Promise<OpenAI> {
    const config = this.config;
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new BridgeError("OpenAI requires apiKey or OPENAI_API_KEY");
    return this.client ??= import("openai").then(({ default: SDK }) => new SDK({
      apiKey, maxRetries: 0,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : {}),
    }));
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToOpenAIInput(req.input);
    const client = await this.getClient();
    const raw = await client.chat.completions.create({ ...input, model: req.model, stream: false });
    return { output: openAIOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const client = await this.getClient();
    const page = await client.models.list();
    return {
      models: page.data.map((model) => ({
        id: model.id, ownedBy: model.owned_by,
        createdAt: new Date(model.created * 1000).toISOString(), raw: model,
      })),
      // Serializing the SDK Page would expose internal request/client state.
      raw: { object: page.object, data: page.data },
    };
  }
}
