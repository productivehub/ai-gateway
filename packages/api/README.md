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
| `response` | `both` (envelope + raw), `output` (envelope without raw), or `raw` (native payload only) | `both` |

The default response retains the bridge envelope. `output` contains the requested
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

### Jev evaluation

Configure `TYPESAFE_API_KEY` to enable provider `jev`. Its default base URL is `https://api.typesafe.ai/v1`; `TYPESAFE_BASE_URL` or a named account's `baseURL` can override it. Both the provider and response dialect are registered by `createDefaultGateway`.

The HTTP body remains canonical `BridgeInput`. Use `jevDialect.toBaseline({ state, questions })` in TypeScript, or send the equivalent JSON:

```sh
curl 'http://127.0.0.1:8787/jev-latest?provider=jev&dialect=jev' \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"My payouts have failed for three days."}],"extensions":{"jev":{"questions":{"urgent":{"type":"noul","instructions":"Is this urgent?"}}}}}'
```

For object/array state, replace the message's content with `[{ "type": "native", "dialect": "jev", "value": { "state": { "message": "Payment failed" } } }]`. Questions support `noul`, `choice` and `score`; see the [bridge Jev example](https://github.com/productivehub/ai-bridge#jev-typesafe). `dialect=jev` returns native typed answers, probabilities and confidence in `output`; the default bridge dialect returns provider-neutral evaluation blocks in `output.choices[0].message.content` and retains native answers in `output.extensions.jev.answers`. The envelope's `model` remains the requested alias, while the Jev projection's `output.model` reports the resolved version.

Named accounts, model aliases and `GET /models` work normally. `GET /allowance` returns 501. Unsupported chat controls or malformed evaluation input return 422 before the provider call. Upstream 429 returns 429 and 529 follows the gateway's provider-failure mapping (502); there are no automatic retries.

### Structured output and raw responses

`dialect=structured` projects typed `boolean`, `choice` and `score` content blocks
to a provider-neutral answer map in `output`, retaining probabilities, confidence
and score legends. The regular bridge dialect carries these blocks directly in
`output.choices[0].message.content`. JEV's probability-only boolean uses
`value: null` and `probability`; callers choose any true/false threshold. Custom providers can
populate `BridgeOutput.structured` too. For chat providers, this dialect parses
one complete JSON assistant answer; request JSON generation with `responseFormat`
in the input. Non-JSON, incomplete, refused, tool-call and multiple-candidate
responses return HTTP 406 when they cannot be projected.

Use the same canonical request body with any of these URLs:

```text
POST /jev-latest?provider=jev&dialect=structured&response=both
POST /jev-latest?provider=jev&dialect=structured&response=output
POST /jev-latest?provider=jev&response=raw
```

`both` returns the projected `output` alongside the untouched native `raw`.
`output` returns the same envelope without `raw`. `raw` returns only the native
JSON body, with no envelope, generated bridge ID or output projection. Raw mode
still validates selection, input and native provider responses. Invalid or
repeated `response` selections return HTTP 400 before the provider call.
Director exposes the same URLs beneath `/api/ai`.

TypeScript callers can use `GatewayResponse<Answers, JevOutput<NativeAnswers>>`,
`GatewayOutputResponse<Answers>` or
`GatewayResult<Answers, JevOutput<NativeAnswers>, "raw">` for the respective bodies.
`Answers` uses the exported `EvaluationAnswer` shapes; `NativeAnswers` describes
the provider's wire answers. The `native` content block and all raw modes remain available.
These generics describe expected types; arbitrary caller-defined fields require
caller-side runtime validation. The bridge supports the same modes through
`complete<T>({ outputDialect, response, ...request })`.

In-process hosts can call `getGatewayCompletionMetadata(response)` to obtain
canonical account/model/usage/timing data even for raw-only replies. Metadata is
associated with the original Response object and does not change its headers or
body; cloned or remote responses do not carry this in-process association.

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

### Remaining allowance

```sh
curl 'http://127.0.0.1:8787/allowance?key=cloud'
# On the director API:
curl 'http://localhost:3000/api/ai/allowance?key=cloud'
```

`GET /allowance` invokes `bridge.getAllowance({ provider })` for the selected
account. It returns the provider's canonical quota plus the gateway `key`,
`provider` and request timing `meta`:

```json
{
  "provider": "ollama-cloud",
  "key": "cloud",
  "available": null,
  "primary": { "id": "included", "kind": "plan", "remainingFraction": 0.42, "period": { "resetsAt": "2026-10-15T00:00:00.000Z" } },
  "windows": [{ "id": "included", "kind": "plan", "remainingFraction": 0.42, "...": "one entry per quota bucket" }],
  "usage": { "from": "2026-10-01", "until": "2026-10-08", "requests": 12, "cost": { "amount": 50, "currency": "USD" } },
  "raw": { "...": "native provider payload" },
  "meta": { "startedAt": "2026-10-04T10:00:00.000Z", "endedAt": "2026-10-04T10:00:00.100Z", "durationMs": 100 }
}
```

A `windows` entry is a quota bucket: `id` and `kind` (`money` or `plan`), optional
`label`, `limit`, `remaining` and `used` amounts, a `remainingFraction` in 0..1
(`null` when the provider reports no ceiling), an optional `period` and the native
payload. `available` is the provider's own verdict or `null`; `primary` is the
window that gates calls. Adapters without allowance support return HTTP 501 with
the bridge's `UnsupportedFeatureError` message. Like `/models`, this endpoint
returns canonical data, so `dialect` is rejected with HTTP 400. Upstream provider
failures keep the shared 502 mapping and their bodies are never echoed.

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

`createDefaultGateway()` wires configured `openai`, `anthropic`, `deepseek`,
`jev`, `ollama`, and `ollama-cloud` accounts and the `openai`, `anthropic`, `jev`, and `ollama`
response dialects. Without JSON config, hosted providers are enabled only with a
nonempty API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`,
`TYPESAFE_API_KEY`, `OLLAMA_CLOUD_API_KEY`); local Ollama requires `OLLAMA_BASE_URL` or an explicit
`providers.ollama.baseURL`.
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
  `endpoints` names the provider routes the gateway knows, including `allowance`
  for accounts that can report one.
- `GET /models/configured`: configured aliases, native model IDs, named keys and providers.
- `GET /models?key=claude-work`: provider model discovery using that account.
- `GET /allowance?key=cloud`: the account's remaining quota and consumed usage.

Director exposes these under `/api/ai`. JSON provider names remain extensible:
pass `providerFactories` to the factory/listener for custom implementations,
default endpoints and connection requirements. The bridge's injectable core and
custom dialects remain available through `createGateway`.

### Merging a host's own keys

A host that stores its own keys can build on the environment-derived config:

- `listGatewayProviders(factories?)`: the provider catalog, one
  `{ id, defaultBaseURL, requiresApiKey, endpoints }` entry per provider
  (`GatewayProviderInfo`). Custom `factories` override or extend the built-ins.
- `resolveDefaultGatewayConfig({ env, providers? })`: the `GatewayConfig`
  `createDefaultGateway` builds when given no `config`, as a plain value to merge into.
- `isGatewayKeyName(value)` and `isGatewayBaseURL(value)`: the same checks the
  config schema applies to account names and endpoint URLs.

A key may set `inheritEnv: false` to read no provider environment variable: no
`apiKeyEnv`/`baseURLEnv` defaults and no `OLLAMA_API_KEY` fallback. Its provider is
built from the key's own `apiKey` and `baseURL` only (a missing `baseURL` falls back
to the provider's default). It cannot be combined with `apiKeyEnv` or `baseURLEnv`.

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

### Caller authentication and project attribution

The gateway supplies no caller authentication or project-ID authorization.
Provider API keys remain server-side and authenticate outgoing provider requests;
they do not authorize callers of this HTTP API. Attach host middleware before
mounting the gateway, and remove internal authentication and project headers
before forwarding requests to it.

The standalone listener binds to `127.0.0.1` by default. This limits direct access
to processes on the same machine; it does not identify a particular user,
harness, or project. Binding to a network interface or exposing the listener
through a proxy requires an explicit caller authentication policy.

Director's current wrapper accepts project bearer tokens through
`Authorization: Bearer phub_...` and attributes usage to the token's project.
`AI_REQUIRE_TOKEN=1` requires a token for completion POSTs; without it, anonymous
completions are allowed and are logged without a project. These are director
settings, not standalone gateway settings. A manifest UUID or `X-Project-Id`
header does not currently grant access or attribute usage.

A host that implements tokenless local project access must explicitly enable
that policy, verify the direct socket peer is loopback, and resolve the supplied
project ID. It must also restrict accepted hosts and browser origins to prevent
DNS rebinding and cross-origin calls. A local reverse proxy makes remote callers
appear local, so keep such a listener unproxied. Project IDs select accounting
records; they do not prove ownership. This policy trusts local processes and
requires stronger credentials or a restricted Unix socket when local users need
isolation.

Protect management endpoints as well as completions: exposing an unauthenticated
token-creation endpoint would let callers mint their own credentials. The
gateway does not add these protections automatically.

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
| 501 | Account's provider cannot report an allowance |
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
