import { describe, expect, it, vi } from "vitest";
import { createBridge, type ProviderModelsResponse } from "@productivehub/ai-bridge";
import { createGateway } from "../src/index.js";
import { fixture, post } from "./helpers.js";

function setup() {
  const { complete } = fixture();
  const result: ProviderModelsResponse = { models: [{ id: "org/model:latest", raw: { native: true } }], raw: { native: true } };
  const first = vi.fn(async () => result);
  const second = vi.fn(async () => ({ models: [], raw: [] }));
  const bridge = createBridge({ providers: {
    first: { complete, listModels: first }, second: { complete, listModels: second }, completionOnly: { complete },
  } });
  const app = createGateway({ bridge, defaultProvider: "first", env: {} });
  return { app, bridge, first, second, complete };
}

describe("GET /models", () => {
  it("uses the configured provider and returns normalized model data with timing", async () => {
    const { app, first, complete } = setup();
    const response = await app.request("/models");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: "first", models: [{ id: "org/model:latest", raw: { native: true } }], raw: { native: true },
      meta: { startedAt: expect.any(String), endedAt: expect.any(String), durationMs: expect.any(Number) },
    });
    expect(first).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses an explicit query provider and permits empty catalogs", async () => {
    const { app, first, second } = setup();
    const response = await app.request("/models?provider=second");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "second", models: [], raw: [] });
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("uses the environment default provider", async () => {
    const { bridge, first, second } = setup();
    const app = createGateway({ bridge, env: { AI_GATEWAY_DEFAULT_PROVIDER: "second" } });
    expect((await app.request("/models")).status).toBe(200);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it.each(["provider=unknown", "provider=", "provider=first&provider=second", "dialect=anthropic"])("rejects invalid query %s before contacting a provider", async (query) => {
    const { app, first, second } = setup();
    expect((await app.request(`/models?${query}`)).status).toBe(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("reports custom providers without discovery support", async () => {
    const { app, complete } = setup();
    const response = await app.request("/models?provider=completionOnly");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Cannot convert model discovery to completionOnly" });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error("private key"), { status: 429 }), 429, "Provider rate limit exceeded"],
    [Object.assign(new Error("private key"), { name: "TimeoutError" }), 504, "Provider request timed out"],
    [Object.assign(new Error("private key"), { status: 401 }), 502, "Provider request failed"],
  ])("sanitizes model-list upstream errors %#", async (error, status, message) => {
    const { app, first } = setup();
    first.mockRejectedValueOnce(error);
    const response = await app.request("/models");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it("still accepts a POST completion for a model named models", async () => {
    const { app, complete, first } = setup();
    const response = await app.request("/models", post());
    expect(response.status).toBe(200);
    expect(complete.mock.calls[0]?.[0].model).toBe("models");
    expect(first).not.toHaveBeenCalled();
  });
});
