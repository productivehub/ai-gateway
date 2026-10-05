import { expect, it } from "vitest";
import { createGateway } from "../src/index.js";
import { listenGateway } from "../src/listener.js";
import { fixture, post } from "./helpers.js";

it("runs a real Node listener on a free port and closes it", async () => {
  const { bridge } = fixture();
  const listener = await listenGateway({ app: createGateway({ bridge, defaultProvider: "test", env: {} }), port: 0, env: {} });
  try {
    expect(listener.runtime).toBe("node");
    expect(listener.port).toBeGreaterThan(0);
    const response = await fetch(`${listener.url}/org/model?dialect=mine`, post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "org/model", output: { answer: "Hello back" } });
  } finally { await listener.close(); }
  await listener.close();
  await expect(fetch(`${listener.url}/health`)).rejects.toThrow();
});

it("validates listener configuration before opening a socket", async () => {
  const { bridge } = fixture();
  const app = createGateway({ bridge, defaultProvider: "test", env: {} });
  await expect(listenGateway({ app, port: -1, env: {} })).rejects.toThrow("port");
  await expect(listenGateway({ app, env: { AI_GATEWAY_PORT: "bad" } })).rejects.toThrow("port");
  await expect(listenGateway({ app, hostname: "", env: {} })).rejects.toThrow("hostname");
});
