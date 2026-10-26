import type Anthropic from "@anthropic-ai/sdk";
import { BridgeError } from "../errors.js";
import type { ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse, ProviderModelsResponse, BridgeModel } from "../types.js";
import { baselineToAnthropicInput, anthropicOutputToBaseline } from "../dialects/anthropic.js";

export class AnthropicProvider implements ProviderAdapter {
  private client: Promise<Anthropic> | undefined;
  private readonly config: ProviderConfig;
  constructor(config: ProviderConfig = {}) { this.config = { ...config }; }

  private getClient(): Promise<Anthropic> {
    const config = this.config;
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new BridgeError("Anthropic requires apiKey or ANTHROPIC_API_KEY");
    return this.client ??= import("@anthropic-ai/sdk").then(({ default: SDK }) => new SDK({
      apiKey, maxRetries: 0,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : {}),
    }));
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input = baselineToAnthropicInput(req.input);
    const client = await this.getClient();
    const raw = await client.messages.create({ ...input, model: req.model, stream: false });
    return { output: anthropicOutputToBaseline(raw), raw };
  }

  async listModels(): Promise<ProviderModelsResponse> {
    const client = await this.getClient();
    const first = await client.models.list();
    const models: BridgeModel[] = [];
    const pages: unknown[] = [];
    for await (const page of first.iterPages()) {
      pages.push({ data: page.data, has_more: page.has_more, first_id: page.first_id, last_id: page.last_id });
      for (const model of page.data) {
        models.push({
          id: model.id, name: model.display_name, createdAt: model.created_at,
          ...(model.max_input_tokens != null ? { maxInputTokens: model.max_input_tokens } : {}),
          ...(model.max_tokens != null ? { maxOutputTokens: model.max_tokens } : {}),
          raw: model,
        });
      }
    }
    return { models, raw: { pages } };
  }
}
