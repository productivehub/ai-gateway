/** Run with Node or Deno against the compiled package; no paid API calls. */
import assert from "node:assert/strict";
import { createDefaultGateway, type GatewayResponse } from "@productivehub/ai-gateway-api";
import { listenGateway } from "@productivehub/ai-gateway-api/listener";
import type { BridgeModelsResponse } from "@productivehub/ai-bridge";

const openai = {
  id: "1", object: "chat.completion", created: 1791072000, model: "model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const anthropic = {
  id: "1", type: "message", role: "assistant", model: "model",
  content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};
const ollama = {
  model: "model", created_at: "2026-10-04T00:00:00.000Z",
  message: { role: "assistant", content: "hello" }, done: true, done_reason: "stop",
  prompt_eval_count: 3, eval_count: 2,
};
function provider(native: unknown, models: unknown) {
  return {
    apiKey: "test-key", baseURL: "http://fake-provider.test",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      return new Response(JSON.stringify(request.method === "GET" ? models : native), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
}
const listener = await listenGateway({
  app: createDefaultGateway({
    env: {}, providers: {
      openai: provider(openai, { object: "list", data: [{ id: "model", created: 1791072000, object: "model", owned_by: "test" }] }),
      anthropic: provider(anthropic, {
        data: [{ id: "model", type: "model", display_name: "Model", created_at: "2026-10-04T00:00:00Z", max_input_tokens: 200_000, max_tokens: 8192 }],
        has_more: false, first_id: "model", last_id: "model",
      }),
      ollama: provider(ollama, { models: [{ name: "model", model: "model" }] }),
      "ollama-cloud": provider(ollama, { models: [{ name: "model", model: "model" }] }),
    },
  }),
  port: 0, env: {},
});
try {
  for (const name of ["openai", "anthropic", "ollama", "ollama-cloud"]) {
    const response = await fetch(`${listener.url}/model?provider=${name}&dialect=anthropic`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const result = await response.json() as GatewayResponse<{ type: string; content: { text: string }[] }>;
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.provider, name);
    assert.equal(result.dialect, "anthropic");
    assert.equal(result.output.type, "message");
    assert.equal(result.output.content[0]?.text, "hello");
    assert.equal(result.usage.totalTokens, 5);
    assert.ok(Number.isFinite(Date.parse(result.meta.startedAt)));
    const modelResponse = await fetch(`${listener.url}/models?provider=${name}`);
    const catalog = await modelResponse.json() as BridgeModelsResponse;
    assert.equal(modelResponse.status, 200, JSON.stringify(catalog));
    assert.equal(catalog.provider, name);
    assert.equal(catalog.models[0]?.id, "model");
    assert.ok(Number.isFinite(Date.parse(catalog.meta.startedAt)));
    assert.ok(!JSON.stringify(catalog).includes("test-key"));
  }
  console.log(`${listener.runtime}: all four providers, model discovery and HTTP dialect projection passed`);
} finally { await listener.close(); }
