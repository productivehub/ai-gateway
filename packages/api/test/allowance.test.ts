import { describe, expect, it, vi } from "vitest";
import { createBridge, ProviderHttpError, type ProviderAllowanceResponse } from "@productivehub/ai-bridge";
import { createGateway, type GatewayAllowanceResponse } from "../src/index.js";
import { fixture } from "./helpers.js";

const result: ProviderAllowanceResponse = {
  windows: [{ id: "balance", kind: "money", remaining: { amount: 1250, currency: "USD" }, remainingFraction: null, period: {} }],
  primary: "balance", available: true, raw: { native: true },
} as unknown as ProviderAllowanceResponse;

function setup(getAllowance: () => Promise<ProviderAllowanceResponse> = async () => result) {
  const { complete } = fixture();
  const supported = vi.fn(getAllowance);
  const bridge = createBridge({ providers: { supported: { complete, getAllowance: supported }, plain: { complete } } });
  const app = createGateway({
    bridge, defaultProvider: "supported", env: {},
    keys: [{ name: "supported", provider: "deepseek", endpoints: {} }],
  });
  return { app, supported, complete };
}

describe("GET /allowance", () => {
  it("returns the adapter allowance with timing, key and provider", async () => {
    const { app, supported, complete } = setup();
    const response = await app.request("/allowance?key=supported");
    expect(response.status).toBe(200);
    const body = await response.json() as GatewayAllowanceResponse;
    expect(body).toMatchObject({
      windows: result.windows, primary: "balance", available: true, raw: { native: true },
      key: "supported", provider: "deepseek",
      meta: { startedAt: expect.any(String), endedAt: expect.any(String), durationMs: expect.any(Number) },
    });
    expect(supported).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the default key when none is supplied", async () => {
    const { app } = setup();
    expect((await app.request("/allowance")).status).toBe(200);
  });

  it("answers 501 with the unsupported message for adapters without getAllowance", async () => {
    const { app } = setup();
    const response = await app.request("/allowance?key=plain");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "Cannot convert allowance to plain" });
  });

  it("maps provider failures to 502 without echoing the provider body", async () => {
    const { app } = setup(async () => { throw new ProviderHttpError(401, "secret-body"); });
    const response = await app.request("/allowance?key=supported");
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Provider request failed" });
    expect(text).not.toContain("secret-body");
  });

  it.each(["key=unknown", "provider=unknown", "key=", "key=supported&dialect=anthropic"])("rejects invalid query %s with 400 before contacting a provider", async (query) => {
    const { app, supported } = setup();
    expect((await app.request(`/allowance?${query}`)).status).toBe(400);
    expect(supported).not.toHaveBeenCalled();
  });

  it("reports unknown key as Unknown key", async () => {
    const { app } = setup();
    expect(await (await app.request("/allowance?key=unknown")).json()).toEqual({ error: "Unknown key" });
  });

  it("keeps completion-path unsupported features at 422", async () => {
    const { app } = setup();
    const response = await app.request("/models?key=plain");
    expect(response.status).toBe(422);
  });
});
