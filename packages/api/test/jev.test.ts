import { afterEach, describe, expect, it, vi } from "vitest";
import { JevProvider, jevDialect, type ProviderConfig } from "@productivehub/ai-bridge";
import { createDefaultGateway, resolveDefaultGatewayConfig, listGatewayProviders, getGatewayCompletionMetadata, type GatewayResponse } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());
const input = jevDialect.toBaseline({ state: { text: "Payment failed" }, questions: { urgent: { type: "noul", instructions: "Is it urgent?" } } });
const output = { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10 } };
function setup(status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const body = request.method === "GET" ? { models: [{ name: "jev-latest", description: "Stable", release_date: "2026-04-01" }] } : output;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  const app = createDefaultGateway({
    config: { keys: { decisions: { provider: "jev", apiKey: "secret", inheritEnv: false } }, models: { triage: { key: "decisions", model: "jev-latest" } } },
    env: {}, providerFactories: { jev: { create: (config) => new JevProvider({ ...config, fetch }) } },
  });
  return { app, calls };
}
const post = (body: unknown = input) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("Jev gateway integration", () => {
  it.each(["both", "output", "raw"])("returns structured evaluations in %s mode with host accounting", async (mode) => {
    const { app } = setup();
    const response = await app.request(`/triage?dialect=structured&response=${mode}`, post());
    expect(response.status).toBe(200);
    expect(getGatewayCompletionMetadata(response)).toMatchObject({
      key: "decisions", provider: "jev", model: "jev-latest", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    });
    const body = await response.json();
    if (mode === "raw") expect(body).toEqual(output);
    else {
      expect(body).toMatchObject({ dialect: "structured", output: { urgent: { type: "boolean", value: null, probability: 0.9 } }, usage: { totalTokens: 110 } });
      if (mode === "both") expect((body as GatewayResponse<typeof output.answers, typeof output>).raw).toEqual(output);
      else expect(body).not.toHaveProperty("raw");
    }
  });
  it("registers TypeSafe configuration and advertises only documented endpoints", async () => {
    const env = { TYPESAFE_API_KEY: "secret", TYPESAFE_BASE_URL: "https://proxy.test/v1" };
    expect(resolveDefaultGatewayConfig({ env }).keys.jev).toMatchObject({ provider: "jev", apiKey: "secret", baseURL: "https://proxy.test/v1" });
    const app = createDefaultGateway({ env });
    const response = await (await app.request("/keys")).json();
    expect(response).toEqual({ keys: [{ name: "jev", provider: "jev", baseURL: "https://proxy.test/v1", endpoints: {
      complete: "https://proxy.test/v1/systemone", models: "https://proxy.test/v1/models",
    } }] });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(listGatewayProviders().find((p) => p.id === "jev")).toEqual({ id: "jev", defaultBaseURL: "https://api.typesafe.ai/v1", requiresApiKey: true, endpoints: ["complete", "models"] });
    expect(() => createDefaultGateway({ config: { keys: { jev: { provider: "jev" } } }, env: {} })).toThrow("requires a configured API key");
  });

  it("routes an alias through a named Jev account with canonical input and native output", async () => {
    const { app, calls } = setup();
    const response = await app.request("/triage?dialect=jev", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "decisions", provider: "jev", model: "jev-latest", dialect: "jev", output,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, raw: output });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(await calls[0]!.json()).toEqual({ model: "jev-latest", state: { text: "Payment failed" }, questions: { urgent: { type: "noul", instructions: "Is it urgent?" } } });
  });

  it("retains typed data under the bridge dialect and discovers models using the same account", async () => {
    const { app } = setup();
    const response = await app.request("/jev-latest?provider=jev", post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dialect: "bridge", output: {
      choices: [{ message: { content: [{ type: "boolean", id: "urgent", value: null, probability: 0.9 }] } }],
      extensions: { jev: { answers: output.answers } },
    } });
    const catalog = await app.request("/models?key=decisions");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ key: "decisions", provider: "jev", models: [{ id: "jev-latest" }] });
    expect((await app.request("/allowance?key=decisions")).status).toBe(501);
  });

  it("rejects unsupported controls before an upstream call and continues to require canonical HTTP input", async () => {
    const { app, calls } = setup();
    expect((await app.request("/triage", post({ ...input, temperature: 0 }))).status).toBe(422);
    expect((await app.request("/triage", post({ ...input, extensions: { jev: { questions: {} } } }))).status).toBe(422);
    expect((await app.request("/triage?dialect=jev", post({ state: "text", questions: {} }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([[429, 429], [529, 502], [401, 502]])("maps upstream %i to gateway %i without retries", async (upstream, expected) => {
    const { app, calls } = setup(upstream);
    expect((await app.request("/triage", post())).status).toBe(expected);
    expect(calls).toHaveLength(1);
  });

  it("isolates named keys from ambient TypeSafe settings", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ambient-secret");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://ambient.invalid");
    const seen: ProviderConfig[] = [];
    const app = createDefaultGateway({ config: { keys: { jev: { provider: "jev", apiKey: "own-secret", inheritEnv: false } } }, env: { TYPESAFE_BASE_URL: "https://other.invalid" },
      providerFactories: { jev: { create: (config) => { seen.push(config); return new JevProvider(config); } } },
    });
    expect((await app.request("/keys")).status).toBe(200);
    expect(seen[0]).toMatchObject({ apiKey: "own-secret", baseURL: "https://api.typesafe.ai/v1" });
  });
});
