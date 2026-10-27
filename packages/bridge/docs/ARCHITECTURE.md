# AI Bridge (`@productivehub/ai-bridge`)

An in-process TypeScript AI bridge with a provider-neutral baseline and injectable providers and dialects.

## Public API

```ts
const bridge = createBridge({
  providers: createBuiltInProviders(),
  dialects: { openai: openaiDialect, anthropic: anthropicDialect },
});
const res = await bridge.complete({
  provider: "ollama",
  model: "llama3.2",
  input: { messages: [{ role: "user", content: "Hello." }] },
});
const claude = res.toDialect("anthropic");
```

By default, completions return the canonical `BridgeResponse`. `outputDialect` selects another output projection; `response: "output"` omits raw, and `response: "raw"` returns the native payload directly without projection. `complete<T>()` types caller-defined projections. The intrinsic `structured` projection reads explicit `BridgeOutput.structured`, maps typed evaluation content to an answer map, or parses one complete JSON chat answer. `output` and `usage` are the bridge's own types; `raw` retains the provider response; `meta` reports bridge-observed start/end timestamps and monotonic elapsed duration. `toDialect(name)` lazily projects `output` into a target response shape, with a return type inferred from the injected converter. It does not make another API call.

`bridge.listModels({ provider })` dispatches optional provider discovery and returns
`BridgeModelsResponse { provider, models, raw, meta }`. Model entries use the
SDK-free `BridgeModel` contract; vendor capabilities remain in each model's `raw`.
Optional `costs: BridgeModelCosts` records input/output/cached-input/cache-write rates
per million tokens and a separate per-request fee. Each rate uses the reusable
`BridgeCost { currency, amount }` contract, where `amount` is a non-negative integer
in the currency's smallest denomination (cents for USD). Missing rates are unknown,
an amount of zero is free, and discovery does not infer pricing or calculate charges.
Discovery is separate from completion dialect conversion and token accounting.
Adapters without discovery throw `UnsupportedFeatureError`; their completion
contract remains unchanged. OpenAI uses Models through its SDK; Anthropic uses
its SDK Models API and fetches all pages; both Ollama adapters use `/api/tags`.
Model-list payloads exclude SDK clients and internal request state.

`bridge.getAllowance({ provider })` dispatches the optional provider allowance method and returns `BridgeAllowanceResponse { provider, available, primary, windows, usage?, raw, meta }`. `available` is the provider's own verdict that calls will succeed (`null` when it has none), `primary` is the window that gates calls, and each `AllowanceWindow` carries a stable `id`, a `kind` (`money` or `plan`), an optional `label`, optional `limit`, `remaining` and `used` amounts as `BridgeCost`, a `remainingFraction`, an optional `period` and the native `raw`. Ollama Cloud reads `/api/balance` and `/api/usage` concurrently with a 15 s default timeout and treats the usage read as optional; DeepSeek reads `/user/balance` with its own key and base URL. Adapters without the method throw `UnsupportedFeatureError` with `feature === "allowance"`.

Requests default to the `bridge` baseline. A registered dialect can optionally implement `toBaseline` to accept native inputs. This request conversion belongs to the bridge, not to providers.

## Architecture

```text
caller input ── optional dialect.toBaseline ──▶ BridgeInput
                                                    │
                                        injected ProviderAdapter
                                                    │
                                             provider wire API
                                                    │
caller ◀── BridgeResponse { output: BridgeOutput, usage, raw, meta }
                     │
                toDialect(name)
                     │
           injected dialect.fromBaseline
                     │
               native response
```

- `src/types.ts`: SDK-free generic contracts for provider/dialect registries, requests and responses. It does not enumerate provider or native dialect names.
- `src/baseline.ts`: the canonical input, messages, blocks, tools, output choices and usage. Defined independently of vendor SDKs.
- `src/bridge.ts`: instance-local registries, request conversion, dispatch, response wrapping and timing. The intrinsic `bridge` and response-only `structured` dialects are reserved.
- `src/providers/`: built-in provider communication. Every provider implements `complete(ProviderRequest): Promise<ProviderResponse>` and only accepts/returns the canonical baseline. Optional `listModels()` returns canonical model metadata and native list data, and optional `getAllowance()` returns the provider's remaining quota and usage. Six opt-in providers: OpenAI, Anthropic, DeepSeek, Jev (TypeSafe), local Ollama and Ollama Cloud. Jev uses direct HTTP for System One evaluation and model discovery; typed state/questions use native baseline fields, and typed answers use provider-neutral boolean, choice and score content blocks, with native extensions retained for compatibility and JSON text projections for chat dialects. The two Ollama adapters share native chat, model discovery and connection handling; DeepSeek reuses the OpenAI SDK for completion and implements discovery and allowance as direct GETs on its own resolved key and base URL.
- `src/dialects/`: conversions between baseline and vendor shapes. The OpenAI and Anthropic modules also contain the wire mappings their provider implementations reuse. The Jev dialect accepts native state/questions and projects typed answers; it rejects projections without Jev answer metadata. The Mistral dialect is bidirectional and also supplies the wire mappings `MistralProvider` uses, including per-request tool-call id rewriting. The Ollama dialect is a response converter; its module contains mappings for the native provider API.

Providers and dialects are passed to `createBridge` at startup as named objects. Custom names, implementations, inputs and outputs require no central union changes. There is no global registration API. `createBuiltInProviders` is an optional convenience defined in the providers folder. It captures configured keys and URLs at startup and omits unconfigured providers. Local Ollama requires an explicit URL. SDK clients are initialized only when used.

## Why our own baseline

Decided 2026-10-04. OpenAI Chat Completions is useful as a caller dialect but cannot faithfully express the union of supported provider features. A baseline built directly on it would lose signed Anthropic thinking and replay, explicit cache controls and cache-write accounting, and Ollama native runtime settings and timings.

The canonical contract includes common chat features plus these richer controls and response details. Tagged native content/tool blocks and namespaced extension fields retain features without a portable representation, including new SDK fields and server-side tools. This escape hatch is explicit: it preserves information without claiming every API accepts it.

## Conversion rules

Request mappings reject unrepresentable features using `UnsupportedFeatureError` before provider communication. Native extensions are forwarded only to their matching API. The model id is supplied by the caller and passed unchanged.

Response conversions return the selected vendor schema. Fields absent from that schema can be omitted from the projection but remain in canonical output and raw data. Multiple candidates cannot silently collapse into a single-message response. Unreported token usage stays null; required native usage fields are not fabricated. Some required native fields, such as an OpenAI creation timestamp when the source reports none, must be synthesized when projecting.

Canonical usage counts input/output inclusively. Anthropic input totals sum ordinary input, cache reads and cache writes. Reasoning counts are a subset of output tokens. Ollama durations are converted from nanoseconds to milliseconds; bridge `meta.durationMs` measures the full call separately.

## First-release scope

Implemented: non-streaming chat, text and image inputs, function tools and tool history, reasoning/thinking controls, cache accounting, structured output mappings, native extensions, response projections, environment/config credentials, injected transports, and timings. Support is provider-dependent and unsupported request conversions are explicit errors.

OpenAI uses Chat Completions through its official SDK; Anthropic uses Messages through its SDK. DeepSeek and xAI use their own OpenAI-compatible Chat Completions through the same SDK (a shared `OpenAICompatibleProvider` base), always with their resolved key and base URL. Mistral calls its Chat Completions over plain `fetch` with its own `mistral` dialect. Ollama uses native `/api/chat`, preserving runtime options, thinking and durations. Cloud uses the same native API with bearer authentication. SDK automatic retries are disabled. Allowance reads exist for Ollama Cloud (`/api/balance` plus optional `/api/usage`) and DeepSeek (`/user/balance`); other adapters reject the request with `UnsupportedFeatureError`.

Deferred: streaming, embeddings, batches, retry/fallback orchestration, price calculation and response caching. These need method-specific contracts; they are not implied by the non-streaming chat baseline.

## TypeScript decision

Chosen because consumers are TypeScript, vendor dialects have official SDK types, and callers need an in-process library. ESM/NodeNext and the repository's strict TypeScript settings apply. The canonical types remain SDK-independent; SDK types belong in the dialect implementations.

Expected consumers: productivehub web and functions packages. See the [README](../README.md) for startup injection, custom integrations and connection settings.
