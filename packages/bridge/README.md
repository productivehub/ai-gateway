<img src="./assets/icon.svg" alt="AI Bridge icon" width="128" height="128" />

# @productivehub/ai-bridge

Call any AI model provider through one provider-neutral format. `ai-bridge` sits between your code and providers such as OpenAI, Anthropic, DeepSeek, Mistral, xAI (Grok), Jev, Perplexity and Ollama: providers translate their native APIs into the `bridge` baseline, and dialects translate the baseline into whichever response shape you need. It does not choose models for you; you name the provider and model on each call. By default, completions return a `BridgeResponse`; use `res.toDialect(name)` when you need another response shape. Query provider model catalogs with `bridge.listModels({ provider })`.

Created and maintained by [Segev Shmueli](https://github.com/segevsh) (`@segevsh`) as part of [productiveHub](https://github.com/productivehub).

Browse the [wiki source pages](./docs/wiki/Home.md) for setup, configuration,
providers, dialects, model discovery, costs, and the API reference. Publication
instructions are in [Maintaining the Wiki](./docs/wiki/Maintaining-the-Wiki.md).

## Getting started

The package uses ESM and requires Node.js 22 or later. From a standalone checkout:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

When used in the `phub-director` monorepo, run `pnpm install` from that repository's root. A workspace consumer can add `"@productivehub/ai-bridge": "workspace:*"` to its dependencies.

Configure the API key or local server URL for the providers you inject; see [connection settings](#connection-settings) below.

```ts
import {
  createBridge,
  createBuiltInProviders,
  openaiDialect,
  anthropicDialect,
  ollamaDialect,
} from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: createBuiltInProviders({
    ollama: { baseURL: "http://localhost:11434" },
  }),
  dialects: {
    openai: openaiDialect,
    anthropic: anthropicDialect,
    ollama: ollamaDialect,
  },
});

const res = await bridge.complete({
  provider: "ollama",
  model: "llama3.2",
  input: {
    maxOutputTokens: 1024,
    messages: [{ role: "user", content: "Summarise this repo in one line." }],
  },
});

res.output;                       // BridgeOutput: full canonical response
res.usage;                        // BridgeUsage: inclusive token counts and details
res.raw;                          // Untouched provider response
res.meta;                         // startedAt / endedAt (UTC ISO 8601), durationMs
const claude = res.toDialect("anthropic"); // Anthropic.Messages.Message
const openai = res.toDialect("openai");   // OpenAI.Chat.Completions.ChatCompletion
const native = res.toDialect("ollama");   // OllamaOutput
res.toDialect("bridge");                 // Same object as res.output
```

Only injected providers and dialects are available, alongside the intrinsic `bridge` and response-only `structured` dialects. Registries belong to each instance; there is no global registration state. Names and native input/output types are inferred from the objects passed at startup.

Providers are lightweight until first use. `createBuiltInProviders(config, env)`
registers hosted providers only with nonempty keys and local Ollama only with an
explicit base URL from config or `OLLAMA_BASE_URL`. Empty settings disable that
provider. The factory captures connections at startup; directly constructed
adapters retain their documented environment fallbacks. OpenAI and Anthropic load
their SDKs lazily. Ollama and Ollama Cloud share the native `/api/chat`
implementation. Calls are non-streaming and do not retry automatically.

## Available models

```ts
const catalog = await bridge.listModels({ provider: "ollama" });
catalog.models.map((model) => model.id); // IDs accepted by that provider
catalog.provider;                     // Registry name used for this query
catalog.raw;                          // Native model-list data
catalog.meta;                         // startedAt, endedAt, durationMs
```

All built-in providers support discovery using their configured credentials,
base URL and transport. OpenAI and Anthropic use their native models endpoints;
Anthropic pages are fetched automatically. Ollama and Ollama Cloud use native
`/api/tags`: local Ollama reports available installed models, while the cloud host
reports its cloud catalog.

DeepSeek and xAI read their OpenAI-compatible `/models` endpoints with their own
credentials; neither synthesizes creation times. xAI also maps `context_length` to
`maxInputTokens` and its listed text-token prices to `costs`. Mistral reads its
`/models` endpoint and maps display names and `max_context_length`. Jev reads TypeSafe's `/v1/models` and maps
reported names and release dates.

`BridgeModelsResponse` contains `provider`, `models`, `raw`, and `meta`. Each
`BridgeModel` has an `id` and native `raw` metadata. Optional common fields include
`name`, `createdAt`, `modifiedAt`, `ownedBy`, `maxInputTokens`, `maxOutputTokens`, and
`sizeBytes`, populated only when the provider reports them. OpenAI creation times
are converted from Unix seconds to ISO 8601; Ollama modification times are kept
separate from creation times. Anthropic's list `raw` groups payloads under
`pages`; SDK clients and request state are excluded from all model-list responses.

Models may include optional `costs: BridgeModelCosts` with any known rates:
`inputPerMillionTokens`, `outputPerMillionTokens`, `cachedInputPerMillionTokens`,
`cacheWritePerMillionTokens`, and `perRequest`. Each rate is a `BridgeCost` object
containing `currency` (an ISO 4217 code such as `USD`) and `amount` (a non-negative
integer in the currency's smallest denomination, e.g. cents for USD). Token rates
apply per 1,000,000 tokens; `perRequest` is a separate fee per request. For example,
this hypothetical rate is USD 2.50 per million input tokens:

```ts
const costs: BridgeModelCosts = {
  inputPerMillionTokens: { currency: "USD", amount: 250 },
};
```

Omitted rates mean unknown, while an explicit `amount: 0` means free. Providers can return partial
pricing metadata; built-in adapters currently omit costs because their model-list
responses do not supply these rates. No prices are inferred or fetched separately.
This metadata describes rates and does not calculate a completion's actual charge.

Catalogs can be empty, and discovery does not guarantee that every listed model
supports chat completions. This catalog is canonical metadata; completion dialect
converters and token usage do not apply to model discovery.

Custom providers can implement optional
`listModels(): Promise<ProviderModelsResponse>`, returning canonical model entries
and native list data. Completion-only providers keep working and throw
`UnsupportedFeatureError` if discovery is requested. Provider names remain
inferred from the startup registry; unknown providers throw `UnknownProviderError`.

## Allowance

```ts
const allowance = await bridge.getAllowance({ provider: "deepseek" });
allowance.available; // Provider's verdict, or null when none is reported
allowance.primary;   // Window that gates calls, or null
allowance.windows;   // Reported currency balances or plan windows
allowance.usage;     // Optional usage report
allowance.raw;       // Native payloads
allowance.meta;      // Request timing
```

`BridgeAllowanceResponse` includes the provider name and request timing alongside
`available`, `primary`, `windows`, optional `usage`, and `raw`. Each window has an
`id`, a `kind` (`money` or `plan`), optional monetary `limit`, `remaining` and `used`
amounts, a `remainingFraction` in 0..1 or `null`, and an optional reporting period.
Money uses `BridgeCost`: a currency code and an integer amount in minor units.

DeepSeek reads `/user/balance` with its own key and base URL. It reports one window
per currency, with `remaining` from `total_balance`, no limit, and no usage report.
Ollama Cloud reads `/api/balance` and `/api/usage` concurrently with a default
15-second timeout; a failed usage read omits only `usage`, and negative balances
read as zero. OpenAI, Anthropic, Jev and local Ollama do not report allowance.
Requesting it from an adapter without support throws `UnsupportedFeatureError`
with `feature === "allowance"`; an unknown provider throws `UnknownProviderError`.

Custom adapters implement `getAllowance(): Promise<ProviderAllowanceResponse>`.
Use `toMinorUnits(value, fractionDigits = 2)` to convert provider decimal amounts;
it rounds half-up without floating-point arithmetic, so `toMinorUnits("1.005")`
returns `101`. The [API reference](./docs/wiki/API-Reference.md) describes window
and usage fields.

## Native input, canonical response

If a dialect includes `toBaseline`, it also accepts native input. Output remains canonical regardless of input dialect:

```ts
const res = await bridge.complete({
  provider: "ollama",
  model: "llama3.2",
  dialect: "anthropic",
  input: {
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello." }],
  },
});
const message = res.toDialect("openai");
```

Omit `dialect` for canonical input. The built-in OpenAI, Anthropic, Mistral, Jev and Perplexity dialects support native input; the Ollama dialect is a response converter.

## Perplexity Agent API

`PerplexityProvider` calls [Perplexity's Agent API](https://docs.perplexity.ai/api-reference/agent-post) at `POST /v1/agent`, with model discovery at `GET /v1/models`. Set `PERPLEXITY_API_KEY`; `PERPLEXITY_BASE_URL` defaults to `https://api.perplexity.ai/v1` and must include `/v1` when overriding the host.

```ts
import { createBridge, createBuiltInProviders, perplexityDialect } from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: createBuiltInProviders(),
  dialects: { perplexity: perplexityDialect },
});
const response = await bridge.complete({
  provider: "perplexity",
  model: "perplexity/sonar", // Or a provider/model ID from listModels().
  dialect: "perplexity",
  input: {
    input: "Find recent developments in battery recycling.",
    tools: [{ type: "web_search" }],
    max_steps: 3,
    max_output_tokens: 2048,
  },
});
const native = response.toDialect("perplexity");
```

`perplexityDialect` accepts `PerplexityInput` and projects `PerplexityOutput`. Canonical requests support system/developer/user/assistant messages, text, images, documents, function calls/results, sampling, reasoning effort and JSON-schema output. Provider-specific controls such as `instructions`, `effort`, `max_steps` and `previous_response_id` live in `extensions.perplexity`; server tools use `{ type: "native", dialect: "perplexity", value: { type: "web_search" } }`. The native dialect prepares these fields for you. Model selection belongs to the bridge request: native `model`, `models` fallback chains and overriding `input` extensions are rejected. Streaming and background execution are unsupported.

Responses retain text citations, ordered native search/tool results, function calls, message boundaries, token/cache usage and cost metadata (`usage.extensions.perplexity.cost`). All agent output items form one candidate. `raw` retains the untouched response. Missing usage stays unknown; failed or unfinished asynchronous responses throw. Discovery keeps native model metadata and omits placeholder `created: 0` timestamps. The provider has no allowance endpoint and reads only its own credentials.

## Mistral

`MistralProvider` calls [Mistral's Chat Completions API](https://docs.mistral.ai/api/endpoint/chat) at `POST /v1/chat/completions`, with model discovery at `GET /v1/models`. Set `MISTRAL_API_KEY`; `MISTRAL_BASE_URL` defaults to `https://api.mistral.ai/v1` and must include `/v1` when overriding the host. It needs no SDK and never reads OpenAI settings.

```ts
import { createBridge, createBuiltInProviders, mistralDialect } from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: createBuiltInProviders(),
  dialects: { mistral: mistralDialect },
});
const response = await bridge.complete({
  provider: "mistral",
  model: "mistral-large-latest",
  input: {
    messages: [{ role: "user", content: "Bonjour" }],
    maxOutputTokens: 256,
    seed: 7,
    extensions: { mistral: { safe_prompt: true } },
  },
});
const native = response.toDialect("mistral");
```

`mistralDialect` accepts `MistralInput` (without model) and projects `MistralOutput`. Mistral validates request fields strictly, so the dialect maps canonical fields to Mistral's names (`max_tokens`, `random_seed`, `top_k`, `n`, `prompt_cache_key`, `reasoning_effort`) and turns `toolChoice: "required"` into `"any"`. Text, images, documents, uploaded files, audio, thinking, function tools and JSON or JSON-schema output are supported. Mistral-only controls such as `safe_prompt`, `prompt_mode` and `parallel_tool_calls` go in `extensions.mistral`.

Mistral requires tool-call ids of exactly nine letters or digits. Ids from other providers are rewritten deterministically for each request, and the matching tool results follow them. The dialect rejects anything Mistral cannot express: cache-control hints, Ollama runtime options, reasoning `mode`/`budgetTokens`/`display`, the `max` effort, named system messages and streaming. Thinking chunks become `thinking` blocks, `model_length` maps to `context-limit`, and cached prompt tokens are reported as `cachedInputTokens`. There is no allowance endpoint.

## xAI (Grok)

`XAIProvider` calls xAI's OpenAI-compatible Chat Completions API at `https://api.x.ai/v1` through the OpenAI SDK, so use `openaiDialect` for native input and output. Set `XAI_API_KEY`; `XAI_BASE_URL` overrides the host. Like DeepSeek, it resolves only its own key and base URL, never reads `OPENAI_*` settings, and strips the SDK's organization and project headers.

Grok's `reasoning_content` is kept in `message.extensions.openai`, and the extra usage fields (`cost_in_usd_ticks`, `num_sources_used`) are kept in `usage.extensions.openai`. Finish reasons the OpenAI dialect does not know, such as `end_turn`, map to `unknown`. Discovery maps `context_length` and the per-100M-token cent prices to `maxInputTokens` and `costs`, but only when a price is a whole number of cents per million tokens; other prices stay in `raw`. Billing lives in xAI's separate Management API, so there is no allowance read.

## Jev (TypeSafe)

Jev evaluates text or structured state against typed questions rather than generating chat. Configure `TYPESAFE_API_KEY` and optionally `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai/v1`). Register `JevProvider` and `jevDialect`, or enable `jev` through `createBuiltInProviders`:

```ts
import { createBridge, createBuiltInProviders, jevDialect } from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: createBuiltInProviders(),
  dialects: { jev: jevDialect },
});
const response = await bridge.complete({
  provider: "jev",
  model: "jev-latest",
  dialect: "jev",
  input: {
    state: { message: "My payouts have been failing for three days." },
    questions: {
      urgent: { type: "noul", instructions: "Is this urgent?" },
      team: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments", technical: "Bugs" } },
      frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm", "Frustrated", "Very angry"] },
    },
  },
});
const { answers, model } = response.toDialect("jev");
// model is the resolved version; response.model retains the requested alias.
```

`JevInput` omits the model, which belongs to the bridge request. `jevDialect.toBaseline(input)` prepares canonical input for an HTTP gateway. A string state becomes one user text message; object/array state becomes one user native block `{ type: "native", dialect: "jev", value: { state } }`. Questions are stored in `extensions.jev.questions`. Jev requires that one state message and rejects chat controls, tools, media and foreign native extensions before calling the API.

The regular bridge response carries one provider-neutral `boolean`, `choice` or `score` block per question in `output.choices[0].message.content`. Blocks use `id` for the question key and `value` for the answer; probabilities, legends and confidence remain typed fields. JEV's `noul` is a probability, so its boolean block has `value: null` and the original `probability`, without applying a threshold. Other providers can report actual `value: true` or `false`.

Callers can switch on `block.type` using the normal `ContentBlock` union, with no JEV-specific parsing. `EvaluationAnswer` and `EvaluationBlock` are exported contracts. The existing `native` block and raw response modes remain available, and `output.extensions.jev.answers` retains the native answers for compatibility. The JEV projection reconstructs native answers from typed blocks; other chat response dialects serialize evaluation groups as JSON text. Native response and usage extensions are preserved.

`JevProvider.listModels()` queries `/models` under the configured `/v1` base URL. It maps native `name` and `release_date`, preserves descriptions in `raw`, and does not infer pricing or token limits. Allowance is unsupported. HTTP errors retain status and body via `ProviderHttpError`, including 429 and 529; calls use a timeout and do not retry automatically. See TypeSafe's [API reference](https://docs.typesafe.ai/api) and [model discovery](https://docs.typesafe.ai/models).

## Baseline features and conversion limits

`src/baseline.ts` defines SDK-independent contracts for:

- Text, image and document sources, audio input, and refusals.
- Function tools, calls and results, including result errors.
- Thinking text, replay signatures and redacted thinking blocks.
- Prompt cache controls, structured JSON output, reasoning controls, multiple candidates, and stop reasons.
- Inclusive token counts, cache reads/writes and TTL breakdowns, reasoning/audio/prediction token details, and server-tool usage.
- Ollama runtime settings, model residency and provider timings.
- Native extension fields and content/tool blocks for features without a portable equivalent.

This is a richer internal representation, not a guarantee that every provider supports every feature. Built-in request converters throw `UnsupportedFeatureError` for features they cannot express. Native extensions are sent only to their matching API; foreign native extensions are rejected.

Response projections return the target schema and can omit fields it cannot represent: for example, an OpenAI Chat Completions response has no signed Anthropic thinking blocks. The full information remains in `res.output` and `res.raw`. Converting multiple candidates into a single-message dialect throws rather than silently selecting one. Invalid tool argument JSON also throws when a target requires parsed JSON.

Unreported token counts are `null` in canonical usage. OpenAI projection can omit its optional usage block; Anthropic projection throws if required counts are unavailable. Anthropic prompt token totals include uncached input, cache reads and cache writes; output counts include thinking tokens. Projected schemas may require synthesized fields: for example, OpenAI `created` uses conversion time when the source reports no creation timestamp.

Anthropic uses `maxOutputTokens` or a default of 4096 for its required `max_tokens`. Provider-native options without portable equivalents can be placed in `input.extensions`, keyed by wire API name, e.g. `{ openai: { logprobs: true } }`.

## Caller-typed structured and raw responses

`outputDialect` selects the returned output independently of the request's `dialect`.
With the Jev bridge configured above, request typed answers directly:

```ts
import type { EvaluationAnswer, JevOutput } from "@productivehub/ai-bridge";

type Answers = { urgent: Extract<EvaluationAnswer, { type: "boolean" }> };
type NativeAnswers = { urgent: { type: "noul"; noul: number } };
const request = {
  provider: "jev" as const,
  model: "jev-latest",
  dialect: "jev" as const,
  input: {
    state: { message: "Payment failed" },
    questions: { urgent: { type: "noul" as const, instructions: "Is this urgent?" } },
  },
};

const result = await bridge.complete<Answers, JevOutput<NativeAnswers>>({
  ...request, outputDialect: "structured", response: "both",
});
result.output.urgent.probability; // provider-neutral evaluation data
result.raw.answers.urgent.noul; // typed untouched provider response

const outputOnly = await bridge.complete<Answers>({
  ...request, outputDialect: "structured", response: "output",
}); // output, usage, meta and converters; no raw property

const rawOnly = await bridge.complete<JevOutput<NativeAnswers>>({
  ...request, response: "raw",
}); // native response directly, without a bridge envelope or output projection
```

Omitted options retain canonical output and raw data (`response: "both"`).
`response: "output"` keeps the envelope and omits raw. `response: "raw"` returns
only the untouched native payload and skips output projections. Provider errors
and native response validation still apply in raw mode.

The intrinsic `structured` projection uses `BridgeOutput.structured` when present;
otherwise it converts typed evaluation blocks into a provider-neutral answer map,
or parses a single, complete JSON assistant answer. Invalid JSON,
multiple candidates, truncated answers, tool calls and refusals cannot be
projected to structured data. Chat callers can request JSON generation with
`input.responseFormat`. The generic `<T>` describes the expected result at compile
time; it does not generate a schema or validate arbitrary caller-defined fields
at runtime. Validate those fields in the caller when needed.

Existing responses can also use `result.toDialect<Answers>("structured")`.
`JevInput<Questions>` and `JevOutput<Answers>` retain caller-defined question and
answer keys. Custom providers can populate `BridgeOutput<T>.structured` directly.

## Custom providers and dialects

No central provider or dialect union needs editing. A provider implements one method returning canonical output and its untouched native response. A dialect needs only a response converter:

```ts
import type {
  ProviderAdapter, ProviderRequest, ProviderResponse, BridgeOutput,
} from "@productivehub/ai-bridge";

class MyProvider implements ProviderAdapter {
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    // Call your API, map its reply into BridgeOutput, and return { output, raw }.
    return callMyAPI(req);
  }
}

const customBridge = createBridge({
  providers: { "my-server": new MyProvider() },
  dialects: {
    summary: {
      fromBaseline(output: BridgeOutput) {
        return { id: output.id, choices: output.choices, tokens: output.usage.totalTokens };
      },
    },
  },
});

const res = await customBridge.complete({
  provider: "my-server",
  model: "my-model",
  input: { messages: [{ role: "user", content: "Hello." }] },
});
const summary = res.toDialect("summary"); // Inferred return type, no cast
```

`callMyAPI` above represents the consumer's API integration. Add an optional `toBaseline(input)` method to a custom dialect when it should also accept its own request shape. A response-only dialect cannot be used as a request dialect.

You may inject just the built-ins you use, or give an adapter your own registry name:

```ts
import { OpenAIProvider } from "@productivehub/ai-bridge/providers";

const privateBridge = createBridge({
  providers: {
    "private-api": new OpenAIProvider({
      baseURL: "https://my-compatible-server.example/v1",
      apiKey: "...",
    }),
  },
});
```

## Connection settings

Built-in providers accept `apiKey`, `baseURL`, `fetch`, and `timeoutMs`. Explicit settings take precedence over environment variables. Injecting `fetch` supports custom transports and tests.

| Provider | Key fallback | Base URL fallback |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | SDK `OPENAI_BASE_URL`, then OpenAI's default |
| Anthropic | `ANTHROPIC_API_KEY` | SDK `ANTHROPIC_BASE_URL`, then Anthropic's default |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL`, then `https://api.deepseek.com` |
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL`, then `https://api.mistral.ai/v1` |
| xAI (Grok) | `XAI_API_KEY` | `XAI_BASE_URL`, then `https://api.x.ai/v1` |
| Jev (TypeSafe) | `TYPESAFE_API_KEY` | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai/v1` |
| Perplexity | `PERPLEXITY_API_KEY` | `PERPLEXITY_BASE_URL`, then `https://api.perplexity.ai/v1` |
| Ollama | Optional `OLLAMA_API_KEY` | `OLLAMA_BASE_URL`, then `http://localhost:11434` |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY`, then `OLLAMA_API_KEY` | `OLLAMA_CLOUD_BASE_URL`, then `https://ollama.com` |

For Ollama, use the server root or `/api` as `baseURL`. Cloud requires a key; local Ollama does not. No hosted-provider credential is reused for local Ollama.

DeepSeek and xAI resolve their own key and base URL at construction, never read the
`OPENAI_*` settings, and strip the OpenAI SDK's organization/project headers. Mistral
does not use the OpenAI SDK at all.

## Harness integration and credentials

A harness calling this library in-process needs the selected provider's
credentials, but no gateway bearer token. The bridge opens no HTTP listener and
does not read director project manifests or authenticate project IDs.

To keep provider credentials in a separate server, call the
[AI gateway](https://github.com/productivehub/ai-gateway/tree/main/packages/api)
over HTTP. Its host controls caller authentication and project usage attribution;
provider credentials and inbound caller credentials have separate purposes.

## Develop

```sh
pnpm -F @productivehub/ai-bridge typecheck
pnpm -F @productivehub/ai-bridge test
pnpm -F @productivehub/ai-bridge build
```

Tests use injected transports and make no external API calls. See [architecture notes](./docs/ARCHITECTURE.md) for the design.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, implementation conventions and validation. Project ownership and contributor credits are listed in [AUTHORS.md](./AUTHORS.md).

## License

Licensed under the [MIT license](./LICENSE). Copyright © 2026 Segev Shmueli.
