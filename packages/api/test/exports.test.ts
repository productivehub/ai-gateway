import { describe, expect, it } from "vitest";
import type { ProviderAdapter, ProviderConfig } from "@productivehub/ai-bridge";
import {
  createDefaultGateway, isGatewayBaseURL, isGatewayKeyName, listGatewayProviders, parseGatewayConfig, resolveDefaultGatewayConfig,
  type GatewayConfig, type GatewayProviderFactories, type GatewayProviderInfo,
} from "../src/index.js";

const fakeAdapter = (): ProviderAdapter => ({ complete: async () => { throw new Error("not called"); } });

describe("listGatewayProviders", () => {
  it("lists exactly the six built-ins with their public fields", () => {
    const expected: GatewayProviderInfo[] = [
      { id: "openai", defaultBaseURL: "https://api.openai.com/v1", requiresApiKey: true, endpoints: ["complete", "models"] },
      { id: "anthropic", defaultBaseURL: "https://api.anthropic.com", requiresApiKey: true, endpoints: ["complete", "models"] },
      { id: "deepseek", defaultBaseURL: "https://api.deepseek.com", requiresApiKey: true, endpoints: ["complete", "models", "allowance"] },
      { id: "jev", defaultBaseURL: "https://api.typesafe.ai/v1", requiresApiKey: true, endpoints: ["complete", "models"] },
      { id: "ollama", defaultBaseURL: null, requiresApiKey: false, endpoints: ["complete", "models"] },
      { id: "ollama-cloud", defaultBaseURL: "https://ollama.com", requiresApiKey: true, endpoints: ["complete", "models", "allowance"] },
    ];
    expect(listGatewayProviders()).toEqual(expected);
  });

  it("gives every entry exactly id, defaultBaseURL, requiresApiKey and endpoints", () => {
    const providers = listGatewayProviders();
    expect(providers).toHaveLength(6);
    for (const info of providers) expect(Object.keys(info).sort()).toEqual(["defaultBaseURL", "endpoints", "id", "requiresApiKey"]);
    const custom = listGatewayProviders({ fake: { create: fakeAdapter } });
    for (const info of custom) expect(Object.keys(info).sort()).toEqual(["defaultBaseURL", "endpoints", "id", "requiresApiKey"]);
  });

  it("merges custom factories: an override keeps built-in fields, a new id is appended", () => {
    const factories: GatewayProviderFactories = {
      openai: { create: fakeAdapter, requiresApiKey: false },
      fake: { create: fakeAdapter, defaultBaseURL: "https://fake.test", requiresApiKey: true, endpoints: { complete: "/c" } },
    };
    const providers = listGatewayProviders(factories);
    expect(providers.map((info) => info.id)).toEqual(["openai", "anthropic", "deepseek", "jev", "ollama", "ollama-cloud", "fake"]);
    expect(providers[0]).toEqual({ id: "openai", defaultBaseURL: "https://api.openai.com/v1", requiresApiKey: false, endpoints: ["complete", "models"] });
    expect(providers[6]).toEqual({ id: "fake", defaultBaseURL: "https://fake.test", requiresApiKey: true, endpoints: ["complete"] });
    expect(providers.slice(1, 6)).toEqual(listGatewayProviders().slice(1, 6));
  });
});

describe("resolveDefaultGatewayConfig", () => {
  const env = { OPENAI_API_KEY: "sk-a", DEEPSEEK_API_KEY: "ds-b", OLLAMA_BASE_URL: "http://local.test" };

  it("yields byte-identical GET /keys through createDefaultGateway({ env }) and an explicit config", async () => {
    const implicit = await createDefaultGateway({ env }).request("/keys");
    const explicit = await createDefaultGateway({ config: resolveDefaultGatewayConfig({ env }), env }).request("/keys");
    const implicitBody = await implicit.text();
    expect(implicit.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(await explicit.text()).toBe(implicitBody);
    const names = (JSON.parse(implicitBody) as { keys: { name: string }[] }).keys.map((key) => key.name).sort();
    expect(names).toEqual(["deepseek", "ollama", "openai"]);
  });

  it("round-trips providers.<p>.timeoutMs into config.keys.<p>.timeoutMs", () => {
    const config = resolveDefaultGatewayConfig({ env, providers: { openai: { apiKey: "sk-a", timeoutMs: 1234 } } });
    expect(config.keys.openai?.timeoutMs).toBe(1234);
    expect(config.keys.openai?.provider).toBe("openai");
    expect(config.keys.deepseek?.apiKey).toBe("ds-b");
    expect(config.keys.deepseek?.timeoutMs).toBeUndefined();
  });
});

describe("validators", () => {
  it("isGatewayKeyName accepts letters/digits/_/- names and rejects the rest", () => {
    expect(isGatewayKeyName("a")).toBe(true);
    expect(isGatewayKeyName("work_1-x")).toBe(true);
    for (const bad of ["-a", "a b", ""]) expect(isGatewayKeyName(bad)).toBe(false);
  });

  it("isGatewayBaseURL accepts plain HTTP(S) URLs and rejects credentials, query, fragment and other schemes", () => {
    expect(isGatewayBaseURL("http://local.test:11434")).toBe(true);
    for (const bad of ["ftp://x", "https://u:p@x", "https://x/?q=1", "https://x/#h"]) expect(isGatewayBaseURL(bad)).toBe(false);
  });
});

describe("inheritEnv", () => {
  const env = { OLLAMA_API_KEY: "ambient-secret", OPENAI_BASE_URL: "http://env.test", OLLAMA_BASE_URL: "http://env-ollama.test" };
  /** Built-in factories overridden with a `create` that records the ProviderConfig it is handed. */
  const recording = () => {
    const seen: Record<string, ProviderConfig> = {};
    const record = (id: string) => ({ create: (config: ProviderConfig) => { seen[id] = config; return fakeAdapter(); } });
    const factories: GatewayProviderFactories = { openai: record("openai"), ollama: record("ollama"), "ollama-cloud": record("ollama-cloud") };
    return { seen, factories };
  };
  const build = (config: GatewayConfig, factories: GatewayProviderFactories) => createDefaultGateway({ config, env, providerFactories: factories });

  it("(a) keyless ollama with inheritEnv:false gets apiKey '' and its own baseURL", () => {
    const { seen, factories } = recording();
    build({ keys: { local: { provider: "ollama", baseURL: "http://local.test", inheritEnv: false } } }, factories);
    expect(seen.ollama?.apiKey).toBe("");
    expect(seen.ollama?.baseURL).toBe("http://local.test");
  });

  it("(b) openai with inheritEnv:false and no baseURL falls to the factory default, not OPENAI_BASE_URL", () => {
    const { seen, factories } = recording();
    build({ keys: { mine: { provider: "openai", apiKey: "sk-x", inheritEnv: false } } }, factories);
    expect(seen.openai?.apiKey).toBe("sk-x");
    expect(seen.openai?.baseURL).toBe("https://api.openai.com/v1");
  });

  it("(c) ollama-cloud with inheritEnv:false and no apiKey throws, ignoring OLLAMA_API_KEY", () => {
    const { factories } = recording();
    const config = (inheritEnv?: boolean): GatewayConfig => ({ keys: { cloud: { provider: "ollama-cloud", ...(inheritEnv === undefined ? {} : { inheritEnv }) } } });
    expect(() => build(config(false), factories)).toThrow("requires a configured API key");
    // Same fixture without inheritEnv succeeds via the OLLAMA_API_KEY fallback, so the throw above is the option's doing.
    const { seen, factories: control } = recording();
    build(config(), control);
    expect(seen["ollama-cloud"]?.apiKey).toBe("ambient-secret");
  });

  it("(c') inheritEnv:false keeps the existing guards: keyless ollama without baseURL still throws", () => {
    const { factories } = recording();
    expect(() => build({ keys: { local: { provider: "ollama", inheritEnv: false } } }, factories)).toThrow("baseURL or OLLAMA_BASE_URL");
  });

  it("(d) control: without inheritEnv, keyless ollama reads ambient OLLAMA_API_KEY", () => {
    const { seen, factories } = recording();
    build({ keys: { local: { provider: "ollama", baseURL: "http://local.test" } } }, factories);
    expect(seen.ollama?.apiKey).toBe("ambient-secret");
    expect(seen.ollama?.baseURL).toBe("http://local.test");
  });

  it("(d) control: without inheritEnv, openai without baseURL reads OPENAI_BASE_URL; inheritEnv:true behaves the same", () => {
    for (const extra of [{}, { inheritEnv: true }]) {
      const { seen, factories } = recording();
      build({ keys: { mine: { provider: "openai", apiKey: "sk-x", ...extra } } }, factories);
      expect(seen.openai?.baseURL).toBe("http://env.test");
    }
  });

  it("(e) parseGatewayConfig rejects inheritEnv:false with apiKeyEnv or baseURLEnv, and accepts it alone", () => {
    expect(() => parseGatewayConfig({ keys: { a: { provider: "openai", inheritEnv: false, apiKeyEnv: "X" } } })).toThrow("inheritEnv");
    expect(() => parseGatewayConfig({ keys: { a: { provider: "openai", inheritEnv: false, baseURLEnv: "X" } } })).toThrow("inheritEnv");
    expect(parseGatewayConfig({ keys: { a: { provider: "openai", apiKey: "sk-x", inheritEnv: false } } }).keys.a?.inheritEnv).toBe(false);
    expect(parseGatewayConfig({ keys: { a: { provider: "openai", apiKeyEnv: "X", inheritEnv: true } } }).keys.a?.inheritEnv).toBe(true);
  });
});
