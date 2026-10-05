import { describe, expect, it, vi } from "vitest";
import { createBridge, UnsupportedFeatureError } from "@productivehub/ai-bridge";
import { Hono } from "hono";
import { createGateway, createDefaultGateway, type GatewayResponse } from "../src/index.js";
import { fixture, input, post } from "./helpers.js";

function setup() {
  const f = fixture();
  return { ...f, app: createGateway({ bridge: f.bridge, defaultProvider: "test", env: {} }) };
}

describe("bridge HTTP transport", () => {
  it("returns a canonical envelope including usage, raw and timing", async () => {
    const { app, complete } = setup();
    const response = await app.request("/llama3.2:latest", post());
    expect(response.status).toBe(200);
    const data = await response.json() as GatewayResponse;
    expect(data).toMatchObject({
      provider: "test", model: "llama3.2:latest", dialect: "bridge",
      output: { model: "llama3.2:latest", choices: [{ message: { content: "Hello back" } }] },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, raw: { native: true },
    });
    expect(Date.parse(data.meta.endedAt)).toBeGreaterThanOrEqual(Date.parse(data.meta.startedAt));
    expect(data.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(data).not.toHaveProperty("toDialect");
    expect(complete).toHaveBeenCalledWith({ model: "llama3.2:latest", input });
  });

  it.each(["anthropic", "openai", "ollama", "mine"])("projects %s output while preserving the envelope", async (dialect) => {
    const { app } = setup();
    const response = await app.request(`/model?dialect=${dialect}`, post());
    expect(response.status).toBe(200);
    const data = await response.json() as GatewayResponse<Record<string, unknown>>;
    expect(data.dialect).toBe(dialect);
    expect(data.usage.totalTokens).toBe(5);
    expect(data.meta.startedAt).toEqual(expect.any(String));
    if (dialect === "anthropic") expect(data.output).toMatchObject({ type: "message", content: [{ type: "text", text: "Hello back" }] });
    if (dialect === "openai") expect(data.output).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "Hello back" } }] });
    if (dialect === "ollama") expect(data.output).toMatchObject({ message: { content: "Hello back" } });
    if (dialect === "mine") expect(data.output).toEqual({ answer: "Hello back" });
  });

  it.each(["org/model:latest", "org%2Fmodel%3Alatest", "model%20name"])("accepts model ID %s", async (path) => {
    const { app, complete } = setup();
    expect((await app.request(`/${path}`, post())).status).toBe(200);
    expect(complete.mock.calls[0]?.[0].model).toBe(decodeURIComponent(path));
  });

  it("selects any injected provider through the query", async () => {
    const { app } = setup();
    const response = await app.request("/model?provider=second&dialect=mine", post());
    expect(await response.json()).toMatchObject({ provider: "second", dialect: "mine" });
  });

  it("mounts beneath another Hono app and retains its own error handler", async () => {
    const { app: child, complete } = setup();
    const app = new Hono().route("/api/ai", child);
    const response = await app.request("/api/ai/org/model:latest?dialect=mine", post());
    expect(response.status).toBe(200);
    expect(complete.mock.calls[0]?.[0].model).toBe("org/model:latest");
    complete.mockRejectedValueOnce(new Error("secret"));
    const failed = await app.request("/api/ai/model", post());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Provider request failed" });
  });

  it.each([
    "/model?provider=unknown", "/model?dialect=unknown", "/model?provider=",
    "/model?dialect=", "/model?provider=test&provider=second", "/model?dialect=bridge&dialect=mine",
  ])("rejects invalid selection %s before contacting the provider", async (url) => {
    const { app, complete } = setup();
    expect((await app.request(url, post())).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { messages: [] }, { messages: [{ role: "bad", content: "hi" }] },
    { messages: [{ role: "user", content: [{ type: "image" }] }] },
    { ...input, maxOutputTokens: -1 }, { ...input, topP: 2 },
    { ...input, stream: true }, { ...input, model: "override" },
    { ...input, provider: "second" }, { ...input, max_tokens: 10 },
    { ...input, tools: [{ type: "function", name: "f" }] },
  ])("rejects malformed or noncanonical input %#", async (body) => {
    const { app, complete } = setup();
    expect((await app.request("/model", post(body))).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("validates recursive tool results and preserves canonical features", async () => {
    const { app, complete } = setup();
    const body = {
      messages: [{ role: "user", content: [{ type: "tool-result", id: "id", content: [
        { type: "text", text: "result", cacheControl: { type: "ephemeral", ttl: "5m" } },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" }, detail: "high" },
      ] }] }],
      reasoning: { mode: "enabled", budgetTokens: 1000 },
      responseFormat: { type: "json-schema", name: "reply", schema: { type: "object" } },
      extensions: { custom: { future: true } },
    };
    expect((await app.request("/model", post(body))).status).toBe(200);
    expect(complete.mock.calls[0]?.[0].input).toEqual(body);
  });

  it("rejects malformed JSON and unsupported content types", async () => {
    const { app, complete } = setup();
    expect((await app.request("/model", { ...post(), body: "{" })).status).toBe(400);
    expect((await app.request("/model", { ...post(), headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await app.request("/model", { ...post(), headers: { "content-type": "application/vnd.bridge+json" } })).status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("enforces actual body bytes even without Content-Length", async () => {
    const { bridge, complete } = fixture();
    const app = createGateway({ bridge, defaultProvider: "test", maxBodyBytes: 10, env: {} });
    expect((await app.request("/model", post())).status).toBe(413);
    expect(complete).not.toHaveBeenCalled();
  });

  it("reads defaults from env and lets options and query override them", async () => {
    const { bridge } = fixture();
    const env = { AI_GATEWAY_DEFAULT_PROVIDER: "second", AI_GATEWAY_DEFAULT_DIALECT: "mine" };
    const fromEnv = createGateway({ bridge, env });
    expect(await (await fromEnv.request("/model", post())).json()).toMatchObject({ provider: "second", dialect: "mine" });
    const fromOptions = createGateway({ bridge, env, defaultProvider: "test", defaultDialect: "bridge" });
    expect(await (await fromOptions.request("/model", post())).json()).toMatchObject({ provider: "test", dialect: "bridge" });
    expect(await (await fromOptions.request("/model?provider=second&dialect=mine", post())).json()).toMatchObject({ provider: "second", dialect: "mine" });
  });

  it("infers a sole provider and validates explicitly configured defaults", async () => {
    const { bridge, complete } = fixture();
    const single = createBridge({ providers: { solo: { complete } } });
    expect(() => createGateway({ bridge: single, env: {} })).not.toThrow();
    const withoutDefault = createGateway({ bridge, env: {} });
    expect((await withoutDefault.request("/model", post())).status).toBe(400);
    expect((await withoutDefault.request("/model?provider=test", post())).status).toBe(200);
    expect(() => createGateway({ bridge, env: { AI_GATEWAY_DEFAULT_PROVIDER: "missing" } })).toThrow("defaultProvider");
    expect(() => createGateway({ bridge, defaultProvider: "test", env: { AI_GATEWAY_DEFAULT_DIALECT: "missing" } })).toThrow("defaultDialect");
    expect(() => createGateway({ bridge, defaultProvider: "test", maxBodyBytes: NaN })).toThrow("maxBodyBytes");
  });

  it("constructs the built-in app without credentials or network calls", async () => {
    expect(await (await createDefaultGateway({ env: {} }).request("/health")).json()).toEqual({ ok: true });
  });

  it.each([
    [Object.assign(new Error("secret upstream body"), { status: 401 }), 502, "Provider request failed"],
    [Object.assign(new Error("secret"), { status: 429 }), 429, "Provider rate limit exceeded"],
    [Object.assign(new Error("secret"), { name: "APIConnectionTimeoutError" }), 504, "Provider request timed out"],
    [new UnsupportedFeatureError("test", "audio"), 422, "Cannot convert audio to test"],
  ])("maps provider errors to HTTP %s", async (error, status, message) => {
    const { bridge, complete } = fixture();
    complete.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const app = createGateway({ bridge, defaultProvider: "test", env: {}, onError });
    const response = await app.request("/model", post());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it("returns 406 when the requested output cannot represent the response", async () => {
    const { bridge, complete } = fixture();
    const result = await complete({ model: "model", input: { messages: [] } });
    result.output.usage.inputTokens = null;
    complete.mockResolvedValueOnce(result);
    const app = createGateway({ bridge, defaultProvider: "test", env: {} });
    const response = await app.request("/model?dialect=anthropic", post());
    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unreported token usage") });
  });

  it("leaves unrelated routes and methods unmatched", async () => {
    const { app } = setup();
    expect((await app.request("/model")).status).toBe(404);
    expect((await app.request("/", post())).status).toBe(404);
  });
});
