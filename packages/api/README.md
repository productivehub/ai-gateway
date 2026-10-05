# productiveHub AI Gateway API

`@productivehub/ai-gateway-api` is the HTTP layer of the
[productiveHub AI Gateway](../../README.md): an MIT-licensed HTTP wrapper for
[`@productivehub/ai-bridge`](https://github.com/productivehub/ai-bridge), created and maintained by [Segev Shmueli](https://github.com/segevsh) for
[productiveHub](https://github.com/productivehub).

Mount its Hono app inside your existing server, or open a standalone Node or Deno
listener. Providers and dialects come from the bridge you inject; custom
registries work without changing the HTTP wrapper. The
[`ai-gateway` CLI](../cli/README.md) speaks this same contract.

## HTTP contract

```sh
curl 'http://127.0.0.1:8787/llama3.2:latest?provider=ollama&dialect=anthropic' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"maxOutputTokens":256}'
```

`POST /{model}` executes a non-streaming completion. The body is canonical
[`BridgeInput`](https://github.com/productivehub/ai-bridge/blob/main/src/baseline.ts)
regardless of the selected response dialect. It supports messages, media, tools,
reasoning, caching, structured output, runtime options and native extensions.
The model comes from the path; namespaced IDs such as `org/model:latest` work
with a literal slash or an encoded `%2F`.

| Query | Meaning | Default |
| --- | --- | --- |
| `provider` | Name in the injected provider registry | Configured default; a sole provider is inferred |
| `key` | Named account, such as `claude-work` | Model alias binding or configured default |
| `dialect` | Name in the injected response dialect registry | `bridge` |

The response always retains the bridge envelope. `output` contains the requested
dialect; `usage` remains canonical and `meta` contains bridge-observed timestamps.
For the example above, the response has this shape:

```json
{
  "provider": "ollama",
  "key": "ollama",
  "model": "llama3.2:latest",
  "dialect": "anthropic",
  "output": { "type": "message", "role": "assistant", "content": [{ "type": "text", "text": "Hello!" }], "...": "other native fields" },
  "usage": { "inputTokens": 8, "outputTokens": 3, "totalTokens": 11 },
  "raw": { "...": "original provider response" },
  "meta": { "startedAt": "2026-10-04T10:00:00.000Z", "endedAt": "2026-10-04T10:00:00.100Z", "durationMs": 100 }
}
```

The `...` entries above abbreviate native fields. HTTP JSON cannot carry
`toDialect()` methods; choose the output dialect through the query parameter.
`GET /health` returns `{ "ok": true }` for liveness without contacting providers.

### Available models

```sh
curl 'http://127.0.0.1:8787/models?provider=ollama'
# On the director API:
curl 'http://localhost:3000/api/ai/models?provider=ollama'
```

`GET /models` invokes `bridge.listModels({ provider })`. Omit `provider` to use the
configured default. The response contains `provider`, canonical `models`, native
`raw` list data, and request timing `meta`:

```json
{
  "provider": "ollama",
  "key": "ollama",
  "models": [{ "id": "llama3.2:latest", "name": "llama3.2:latest", "raw": { "name": "llama3.2:latest" } }],
  "raw": { "models": [{ "name": "llama3.2:latest" }] },
  "meta": { "startedAt": "2026-10-04T10:00:00.000Z", "endedAt": "2026-10-04T10:00:00.100Z", "durationMs": 100 }
}
```

Built-in providers support discovery; Anthropic pagination is handled by the
bridge. A custom completion-only provider returns HTTP 422 for discovery.
Empty catalogs return HTTP 200 with `models: []`. Model catalogs use the bridge's
canonical metadata format; `dialect` applies to completion output and is rejected
on this endpoint. Discovery reports the provider's catalog without filtering to
chat-compatible models. `POST /models` still runs a completion for a model whose
ID is literally `models`.

## Create an app or listener

```ts
import { createBridge, OllamaProvider, anthropicDialect } from "@productivehub/ai-bridge";
import { createGateway } from "@productivehub/ai-gateway-api";
import { listenGateway } from "@productivehub/ai-gateway-api/listener";

const bridge = createBridge({
  providers: { local: new OllamaProvider() },
  dialects: { anthropic: anthropicDialect },
});
const app = createGateway({
  bridge,
  defaultProvider: "local",
  defaultDialect: "bridge",
});

const listener = await listenGateway({ app, port: 8787 });
console.log(listener.url);
// Shut down when your host needs to stop:
// await listener.close();
```

Creating or importing the app never opens a socket. The listener uses native
`Deno.serve` on Deno and `@hono/node-server` on Node. Port `0` selects an available
port; `close()` waits for shutdown and can be called repeatedly.

`createDefaultGateway()` wires configured `openai`, `anthropic`, `ollama`, and
`ollama-cloud` accounts and the `openai`, `anthropic`, and `ollama` response dialects.
Without JSON config, hosted providers are enabled only with a nonempty API key;
local Ollama requires `OLLAMA_BASE_URL` or an explicit `providers.ollama.baseURL`.
Credentials and endpoints are captured at startup; SDK clients initialize on first
use. A sole account is selected automatically. With multiple accounts, select a
key/provider per request or configure a default. With no accounts, `/health` works,
`/keys` is empty, and model requests return HTTP 400 without provider communication.

Use `providers` for simple built-in connection options or `config` for named
accounts and model routes. They cannot be supplied together. Use
`createGateway({ bridge })` for arbitrary custom bridge registries.

## JSON startup config and named accounts

Both standalone serving and mounting accept the same `GatewayConfig`:

```json
{
  "defaultKey": "claude-work",
  "defaultDialect": "bridge",
  "port": 8787,
  "keys": {
    "claude-work": { "provider": "anthropic", "apiKeyEnv": "ANTHROPIC_WORK_API_KEY" },
    "claude-personal": { "provider": "anthropic", "apiKeyEnv": "ANTHROPIC_PERSONAL_API_KEY" },
    "cloud": { "provider": "ollama-cloud", "apiKeyEnv": "OLLAMA_CLOUD_API_KEY" }
  },
  "models": {
    "writer": { "key": "claude-work", "model": "your-claude-model-id" },
    "coder": { "key": "cloud", "model": "your-cloud-model-id" }
  }
}
```

`keys` is a map of stable account names to connection settings. Each entry supports
`provider`, `apiKey` **or** `apiKeyEnv`, `baseURL` **or** `baseURLEnv`, and `timeoutMs`.
Hosted accounts require a resolved key. Local Ollama requires a resolved URL; no
implicit localhost connection is made. Endpoint URLs cannot embed credentials or
query parameters. Explicit JSON accounts form the complete available registry;
unlisted environment accounts are not added automatically.

`models` maps public aliases to native model IDs and named keys. `POST /writer`
uses the actual model and account in that route. Conflicting account overrides
return HTTP 400. Native model IDs can also be posted directly with `?key=name`.
`?provider=anthropic` works when one matching account exists; with multiple Claude
accounts, use `?key=claude-work` or `?key=claude-personal`.

Standalone, through the [`ai-gateway` CLI](../cli/README.md):

```sh
ai-gateway serve --config ./gateway.config.json
# AI_GATEWAY_CONFIG=./gateway.config.json is also supported.
```

Director or another host can pass its already-defined config directly:

```ts
import { createDefaultGateway, type GatewayConfig } from "@productivehub/ai-gateway-api";
import { listenGateway } from "@productivehub/ai-gateway-api/listener";

const config: GatewayConfig = {
  keys: {
    "claude-work": { provider: "anthropic", apiKey: workAccountKey },
    cloud: { provider: "ollama-cloud", apiKey: cloudAccountKey },
  },
  models: { writer: { key: "claude-work", model: selectedClaudeModel } },
};

const app = createDefaultGateway({ config });
director.route("/api/ai", app); // Shares the director's listener.
// Alternatively, open a standalone listener directly from the same config:
const listener = await listenGateway({ config });
```

The director runner also accepts `AI_GATEWAY_CONFIG`. `loadGatewayConfig(path)`
loads and validates JSON for hosts that manage their own lifecycle. Programmatic
options override JSON settings, which override environment HTTP defaults. JSON
`port` and `hostname` affect only standalone listeners.

Public discovery endpoints:

- `GET /keys`: `{ keys: [{ name, provider, baseURL, endpoints }] }`. Only public
  account metadata is serialized; API keys and environment references are excluded.
- `GET /models/configured`: configured aliases, native model IDs, named keys and providers.
- `GET /models?key=claude-work`: provider model discovery using that account.

Director exposes these under `/api/ai`. JSON provider names remain extensible:
pass `providerFactories` to the factory/listener for custom implementations,
default endpoints and connection requirements. The bridge's injectable core and
custom dialects remain available through `createGateway`.

## Mount in an existing server

```ts
import { Hono } from "hono";
import { createDefaultGateway } from "@productivehub/ai-gateway-api";

const server = new Hono();
server.route("/api/ai", createDefaultGateway());
// Pass server.fetch to your existing HTTP listener.
```

The director API already mounts this app at `/api/ai`, so requests use
`POST /api/ai/{model}?dialect=...` on the director port. It creates no second
listener. Tests and alternate hosts can inject the app through `EdgeDeps.aiGateway`.

## Configuration

Programmatic options override JSON settings and environment variables. App settings are captured
when `createGateway()` is called; listener settings when `listenGateway()` is
called. `env` optionally supplies a separate map for these HTTP settings.
The supplied `env` also resolves provider credentials, base URLs and named config
environment references; it isolates setup from ambient process credentials.

| Environment variable | Programmatic option | Default |
| --- | --- | --- |
| `AI_GATEWAY_DEFAULT_PROVIDER` | `defaultProvider` / JSON `defaultKey` | Sole configured key; otherwise select explicitly |
| `AI_GATEWAY_CONFIG` | `config` or CLI `--config` | No file; configured environment accounts only |
| `AI_GATEWAY_DEFAULT_DIALECT` | `defaultDialect` | `bridge` |
| `AI_GATEWAY_MAX_BODY_BYTES` | `maxBodyBytes` | 16777216 (16 MiB) |
| `AI_GATEWAY_PORT` | Listener `port` | 8787 |
| `AI_GATEWAY_HOSTNAME` | Listener `hostname` | 127.0.0.1 |

Node 22+ or Deno 2+ is supported. Deno is an optional runtime; provider latency
usually dominates these requests, and no throughput advantage is claimed without
measurements. The compiled ESM uses installed npm dependencies, avoiding runtime
transpilation or unstable runtime import flags.

## Validation and errors

Bodies must be JSON (`application/json` or `application/*+json`). The byte limit
is enforced while reading, including requests without `Content-Length`. Unknown
canonical fields are rejected; place native additions under `extensions`.
`model`, `provider`, and `stream` do not belong in the body.

Errors return `{ "error": "message" }`:

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, canonical input or provider/dialect selection |
| 406 | Selected response dialect cannot represent the result |
| 413 | Request exceeds the configured byte limit |
| 415 | Unsupported content type |
| 422 | Provider cannot support a requested canonical feature |
| 429 | Upstream rate limit |
| 502 | Provider request failed |
| 504 | Provider timeout |

An output-conversion error can occur after the provider has executed the request.
Use `onError` to log original upstream failures; HTTP errors exclude SDK payloads
and stack traces. The package supplies no authentication middleware; hosts can
attach their existing Hono middleware before mounting the app.

## Development

```sh
pnpm -F @productivehub/ai-gateway-api test
pnpm -F @productivehub/ai-gateway-api typecheck  # build bridge first on a fresh checkout
pnpm -F @productivehub/ai-gateway-api test:runtime
cd oss/ai-gateway/packages/api
deno run --allow-net --allow-env --allow-read test/runtime-smoke.ts
deno check --unstable-sloppy-imports test/runtime-smoke.ts
```

The optional Deno checker flag resolves Node-style `.js` declaration references
in this linked workspace. Runtime serving does not need it. Runtime smoke checks
exercise all four providers through a real listener with mocked upstream HTTP;
they require no API keys or paid requests.

See [CONTRIBUTING.md](../../CONTRIBUTING.md), [AUTHORS.md](../../AUTHORS.md), and [LICENSE](./LICENSE).
