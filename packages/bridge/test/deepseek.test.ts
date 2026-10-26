import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeError, DeepSeekProvider, OpenAIProvider, ProviderHttpError,
  createBuiltInProviders, resolveBuiltInProviderConfig,
} from "../src/index.js";
import { openaiResponse } from "./fixtures.js";

const input = { messages: [{ role: "user" as const, content: "hi" }] };

/** Records url and headers of every call, answering by path. */
function recorder(responses: Record<string, { body: unknown; status?: number }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: typeof globalThis.fetch = async (reqInput, init) => {
    const req = new Request(reqInput, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({ url: req.url, headers });
    const path = new URL(req.url).pathname;
    const hit = responses[path];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const fixture = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
};
const models = { object: "list", data: [{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }] };

afterEach(() => vi.unstubAllEnvs());

describe("DeepSeekProvider key isolation (A1)", () => {
  it("rejects every arm before any fetch when only OpenAI settings exist", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
    vi.stubEnv("OPENAI_BASE_URL", "http://openai.invalid");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const http = recorder({});
    for (const provider of [new DeepSeekProvider({ fetch: http.fetch }), new DeepSeekProvider({ apiKey: "  ", fetch: http.fetch })]) {
      await expect(provider.complete({ model: "deepseek-chat", input })).rejects.toBeInstanceOf(BridgeError);
      await expect(provider.listModels()).rejects.toBeInstanceOf(BridgeError);
      await expect(provider.getAllowance()).rejects.toThrow("DeepSeek requires apiKey or DEEPSEEK_API_KEY");
    }
    expect(http.calls).toHaveLength(0);
  });

  it("sends only the DeepSeek key to api.deepseek.com, never OpenAI settings", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
    vi.stubEnv("OPENAI_BASE_URL", "http://openai.invalid");
    vi.stubEnv("OPENAI_ORG_ID", "org-openai");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-openai");
    vi.stubEnv("DEEPSEEK_API_KEY", "ds-key");
    const http = recorder({
      "/chat/completions": { body: openaiResponse }, "/models": { body: models }, "/user/balance": { body: fixture },
    });
    const provider = new DeepSeekProvider({ fetch: http.fetch });
    await provider.complete({ model: "deepseek-chat", input });
    const listed = await provider.listModels();
    expect(listed.models).toEqual([{ id: "deepseek-chat", ownedBy: "deepseek", raw: models.data[0] }]);
    expect(listed.raw).toEqual(models);
    await provider.getAllowance();
    expect(http.calls.map((c) => new URL(c.url).pathname)).toEqual(["/chat/completions", "/models", "/user/balance"]);
    for (const call of http.calls) {
      expect(call.url.startsWith("https://api.deepseek.com/")).toBe(true);
      expect(call.headers.authorization).toBe("Bearer ds-key");
      expect(JSON.stringify(call.headers)).not.toMatch(/sk-openai-secret|org-openai|proj-openai/);
      expect(call.headers["openai-organization"]).toBeUndefined();
      expect(call.headers["openai-project"]).toBeUndefined();
    }
  });

  it("uses DEEPSEEK_BASE_URL and config over the OpenAI base URL", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://openai.invalid");
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://env.deepseek.test/");
    const http = recorder({ "/user/balance": { body: fixture } });
    await new DeepSeekProvider({ apiKey: "ds-key", fetch: http.fetch }).getAllowance();
    await new DeepSeekProvider({ apiKey: "ds-key", baseURL: "http://cfg.deepseek.test", fetch: http.fetch }).getAllowance();
    expect(http.calls.map((c) => c.url)).toEqual(["http://env.deepseek.test/user/balance", "http://cfg.deepseek.test/user/balance"]);
  });

  it("maps a 401 from /models to a DeepSeek ProviderHttpError", async () => {
    const http = recorder({ "/models": { body: {}, status: 401 } });
    await expect(new DeepSeekProvider({ apiKey: "ds-key", fetch: http.fetch }).listModels())
      .rejects.toMatchObject({ status: 401, message: "DeepSeek returned HTTP 401" });
  });

  it("is an OpenAIProvider", () => {
    expect(new DeepSeekProvider({ apiKey: "k" })).toBeInstanceOf(OpenAIProvider);
  });
});

describe("DeepSeekProvider.getAllowance (A2)", () => {
  const provider = (body: unknown, status = 200) => {
    const http = recorder({ "/user/balance": { body, status } });
    return { http, provider: new DeepSeekProvider({ apiKey: "ds-key", fetch: http.fetch }) };
  };

  it("maps the ENDPOINTS.md fixture", async () => {
    const { http, provider: p } = provider(fixture);
    const res = await p.getAllowance();
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.headers.accept).toBe("application/json");
    expect(res.windows).toHaveLength(1);
    const w = res.windows[0]!;
    expect(w).toMatchObject({ id: "balance", kind: "money", label: "Balance (CNY)", remaining: { currency: "CNY", amount: 11000 }, remainingFraction: null });
    expect(w.limit).toBeUndefined();
    expect(w.used).toBeUndefined();
    expect(w.raw).toMatchObject({ granted_balance: "10.00", topped_up_balance: "100.00" });
    expect(res.available).toBe(true);
    expect(res.primary?.id).toBe("balance");
    expect(res.usage).toBeUndefined();
    expect(res.raw).toEqual(fixture);
    expect(JSON.stringify(res.raw)).not.toContain("ds-key");
  });

  it("maps multiple currencies, primary is the first", async () => {
    const res = await provider({
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "110.00" }, { currency: "USD", total_balance: "5.25" }],
    }).provider.getAllowance();
    expect(res.windows.map((w) => [w.id, w.remaining])).toEqual([
      ["balance-cny", { currency: "CNY", amount: 11000 }], ["balance-usd", { currency: "USD", amount: 525 }],
    ]);
    expect(res.primary?.id).toBe("balance-cny");
    expect(res.available).toBe(false);
  });

  it("reports available null and no primary for an empty/flagless body", async () => {
    const res = await provider({ balance_infos: [] }).provider.getAllowance();
    expect(res).toMatchObject({ available: null, primary: null, windows: [] });
  });

  it("throws ProviderHttpError naming DeepSeek on non-OK", async () => {
    const err = await provider({ error: "bad key" }, 401).provider.getAllowance().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("DeepSeek returned HTTP 401");
    expect(JSON.stringify({ message: err.message, body: err.body })).not.toContain("ds-key");
  });

  it("rejects malformed bodies with BridgeError", async () => {
    await expect(provider({ is_available: true }).provider.getAllowance()).rejects.toBeInstanceOf(BridgeError);
    await expect(provider({ balance_infos: [{ currency: "CNY", total_balance: "abc" }] }).provider.getAllowance()).rejects.toBeInstanceOf(BridgeError);
    await expect(provider({ balance_infos: [{ currency: "CNY" }] }).provider.getAllowance()).rejects.toBeInstanceOf(BridgeError);
  });

  it("keeps the Ollama error message byte-identical", () => {
    expect(new ProviderHttpError(500, "x").message).toBe("Ollama returned HTTP 500");
  });
});

describe("DeepSeek registration (A3)", () => {
  it("registers only with a non-blank DeepSeek key", () => {
    expect(createBuiltInProviders({}, { DEEPSEEK_API_KEY: "k" }).deepseek).toBeInstanceOf(DeepSeekProvider);
    expect(createBuiltInProviders({}, { OPENAI_API_KEY: "x" })).not.toHaveProperty("deepseek");
    expect(createBuiltInProviders({}, { DEEPSEEK_API_KEY: "  " })).not.toHaveProperty("deepseek");
    expect(createBuiltInProviders({ deepseek: { apiKey: "k" } }, {}).deepseek).toBeInstanceOf(DeepSeekProvider);
  });
  it("resolves the base URL", () => {
    expect(resolveBuiltInProviderConfig({}, { DEEPSEEK_API_KEY: "k" }).deepseek?.baseURL).toBe("https://api.deepseek.com");
    expect(resolveBuiltInProviderConfig({}, { DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "http://x.test" }).deepseek?.baseURL).toBe("http://x.test");
  });
});
