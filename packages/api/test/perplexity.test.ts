import { afterEach, describe, expect, it, vi } from "vitest";
import { PerplexityProvider, type ProviderConfig } from "@productivehub/ai-bridge";
import { createDefaultGateway, getGatewayCompletionMetadata, listGatewayProviders, resolveDefaultGatewayConfig } from "../src/index.js";

const output = { id: "resp_1", model: "provider/resolved", object: "response", created_at: 1_700_000_000, status: "completed",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.test", title: "Source", start_index: 0, end_index: 6 }] }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cost: { currency: "USD", total_cost: 0.001 } },
};
const input = { messages: [{ role: "user", content: "Research" }], extensions: { perplexity: { max_steps: 3 } },
  tools: [{ type: "native", dialect: "perplexity", value: { type: "web_search" } }] };
const post = (body: unknown = input) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function setup(status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const body = status !== 200 ? { error: { message: "private upstream detail" } } : request.method === "GET"
      ? { object: "list", data: [{ id: "provider/model", created: 0, owned_by: "provider" }] } : output;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  const app = createDefaultGateway({ env: {},
    config: { keys: { research: { provider: "perplexity", apiKey: "secret", inheritEnv: false } }, models: { research: { key: "research", model: "provider/model" } } },
    providerFactories: { perplexity: { create: (config) => new PerplexityProvider({ ...config, fetch }) } },
  });
  return { app, calls };
}
afterEach(() => vi.unstubAllEnvs());

describe("Perplexity gateway", () => {
  it.each(["both", "output", "raw"])("routes a named account and alias with native output in %s mode", async (mode) => {
    const { app, calls } = setup();
    const response = await app.request(`/research?dialect=perplexity&response=${mode}`, post());
    expect(response.status).toBe(200);
    expect(getGatewayCompletionMetadata(response)).toMatchObject({ key: "research", provider: "perplexity", model: "provider/model", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    const body = await response.json();
    if (mode === "raw") expect(body).toEqual(output);
    else {
      expect(body).toMatchObject({ key: "research", provider: "perplexity", model: "provider/model", dialect: "perplexity", output, usage: { totalTokens: 12 } });
      if (mode === "both") expect(body).toHaveProperty("raw", output);
      else expect(body).not.toHaveProperty("raw");
    }
    expect(calls[0]!.url).toBe("https://api.perplexity.ai/v1/agent");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(await calls[0]!.json()).toEqual({ model: "provider/model", stream: false, input: [{ type: "message", role: "user", content: "Research" }], max_steps: 3, tools: [{ type: "web_search" }] });
  });

  it("accepts namespaced model IDs and discovers models without claiming allowance support", async () => {
    const { app, calls } = setup();
    const response = await app.request("/provider%2Fmodel?key=research", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dialect: "bridge", output: { choices: [{ message: { content: [{ type: "text", text: "Answer", citations: output.output[0]!.content[0]!.annotations }] } }] } });
    expect((await calls[0]!.json() as { model: string }).model).toBe("provider/model");
    const catalog = await app.request("/models?key=research");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ provider: "perplexity", models: [{ id: "provider/model", ownedBy: "provider" }] });
    expect(calls[1]!.url).toBe("https://api.perplexity.ai/v1/models");
    expect((await app.request("/allowance?key=research")).status).toBe(501);
    expect(calls).toHaveLength(2);
  });

  it("registers environment settings and exposes credential-free endpoint metadata", async () => {
    const env = { PERPLEXITY_API_KEY: "secret", PERPLEXITY_BASE_URL: "https://proxy.test/v1" };
    expect(resolveDefaultGatewayConfig({ env }).keys.perplexity).toMatchObject({ provider: "perplexity", apiKey: "secret", baseURL: "https://proxy.test/v1" });
    expect(resolveDefaultGatewayConfig({ env: {} }).keys).not.toHaveProperty("perplexity");
    const response = await createDefaultGateway({ env }).request("/keys");
    const body = await response.json();
    expect(body).toEqual({ keys: [{ name: "perplexity", provider: "perplexity", baseURL: "https://proxy.test/v1", endpoints: {
      complete: "https://proxy.test/v1/agent", models: "https://proxy.test/v1/models",
    } }] });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(listGatewayProviders().find((p) => p.id === "perplexity")).toEqual({ id: "perplexity", defaultBaseURL: "https://api.perplexity.ai/v1", requiresApiKey: true, endpoints: ["complete", "models"] });
    expect(() => createDefaultGateway({ env: {}, config: { keys: { research: { provider: "perplexity" } } } })).toThrow("requires a configured API key");
  });

  it("keeps stored accounts independent of ambient Perplexity settings", () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "ambient-secret");
    vi.stubEnv("PERPLEXITY_BASE_URL", "https://ambient.invalid");
    const seen: ProviderConfig[] = [];
    createDefaultGateway({ env: { PERPLEXITY_API_KEY: "other", PERPLEXITY_BASE_URL: "https://other.invalid" },
      config: { keys: { research: { provider: "perplexity", apiKey: "own-secret", inheritEnv: false } } },
      providerFactories: { perplexity: { create: (config) => { seen.push(config); return new PerplexityProvider(config); } } },
    });
    expect(seen[0]).toMatchObject({ apiKey: "own-secret", baseURL: "https://api.perplexity.ai/v1" });
  });

  it("rejects streaming, background work, model overrides and native HTTP bodies before fetching", async () => {
    const { app, calls } = setup();
    for (const extension of [{ stream: true }, { background: true }, { models: ["other/model"] }, { model: "other/model" }]) {
      expect((await app.request("/research", post({ ...input, extensions: { perplexity: extension } }))).status).toBe(422);
    }
    expect((await app.request("/research?dialect=perplexity", post({ input: "Native input" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([[401, 502], [429, 429], [500, 502]])("maps HTTP %i to %i without leaking upstream detail", async (status, expected) => {
    const { app, calls } = setup(status);
    const response = await app.request("/research", post());
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("private upstream detail");
    expect(calls).toHaveLength(1);
  });
});
