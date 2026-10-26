# Dialects

The `bridge` dialect is the canonical baseline. It is defined independently of vendor SDKs and includes common chat features plus provider-specific information that can be retained through tagged blocks and namespaced extensions.

Providers communicate through this baseline. Dialects convert caller input into the baseline or project canonical output into the caller's requested format.

## Built-in dialects

| Name | Native request conversion | Response projection |
| --- | --- | --- |
| `bridge` | Canonical input | Canonical output, returned unchanged |
| `structured` | Response-only dialect | Explicit structured data, an answer map from evaluation blocks, or one complete parsed JSON chat answer |
| `openai` | OpenAI Chat Completions input | OpenAI Chat Completions response |
| `anthropic` | Anthropic Messages input | Anthropic Messages response |
| `mistral` | Mistral Chat Completions input (`MistralInput`, without model) | Mistral Chat Completions response (`MistralOutput`) |
| `jev` | TypeSafe state and typed questions (`JevInput`, without model) | TypeSafe typed answers and usage (`JevOutput`) |
| `perplexity` | Agent input items and controls (`PerplexityInput`, without model) | Agent response items, citations and usage (`PerplexityOutput`) |
| `ollama` | Response-only dialect | Native Ollama chat response |

The `bridge` and response-only `structured` dialects are intrinsic and reserved. Inject `openaiDialect`, `anthropicDialect`, `mistralDialect`, `jevDialect`, `perplexityDialect`, or `ollamaDialect` under the names you want to expose. Dialect names do not have to match provider names: xAI (Grok), DeepSeek and other OpenAI-compatible providers use `openai`. See [caller-typed structured and raw responses](https://github.com/productivehub/ai-bridge#caller-typed-structured-and-raw-responses) for `complete<T>()`, `outputDialect` and the three response modes.

## Convert a response

```ts
import {
  createBridge,
  OllamaProvider,
  anthropicDialect,
  openaiDialect,
} from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: { local: new OllamaProvider({ baseURL: "http://localhost:11434" }) },
  dialects: { anthropic: anthropicDialect, openai: openaiDialect },
});

const response = await bridge.complete({
  provider: "local",
  model: "llama3.2",
  input: { messages: [{ role: "user", content: "Hello" }] },
});

const canonical = response.toDialect("bridge");
const anthropic = response.toDialect("anthropic");
const openai = response.toDialect("openai");
```

`toDialect` is synchronous and makes no network request. Its return type follows the registered dialect. Full information remains in `response.output` and `response.raw`.

## Accept native input

Set the request's `dialect` to a registered service with `toBaseline(input)`. Omit `dialect` for canonical input. The returned response still uses the bridge baseline; request conversion does not select the output projection.

For example, an Anthropic request uses `max_tokens` and Anthropic message blocks. The bridge converts these to canonical input before dispatching to the selected provider. A response-only dialect cannot be used as the input dialect.

Jev input carries a single user state message and `extensions.jev.questions`. String state is text; object/array state uses `{ type: "native", dialect: "jev", value: { state } }`. The regular output content contains provider-neutral `boolean`, `choice` and `score` blocks keyed by question `id`. JEV's boolean result has `value: null` and its original `probability`; choice and score blocks use `value` and retain probabilities, confidence and score legends. Native answers remain under `output.extensions.jev.answers` for compatibility. The Jev projection reconstructs native answers from evaluation blocks and requires the corresponding metadata and known token counts. OpenAI, Anthropic and Ollama response projections serialize evaluation groups into JSON text. See [the Jev example](https://github.com/productivehub/ai-bridge#jev-typesafe).

## Add a custom response dialect

```ts
import { createBridge, OllamaProvider, type BridgeOutput } from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: { local: new OllamaProvider({ baseURL: "http://localhost:11434" }) },
  dialects: {
    summary: {
      fromBaseline(output: BridgeOutput) {
        return { id: output.id, choices: output.choices, usage: output.usage };
      },
    },
  },
});

const response = await bridge.complete({
  provider: "local",
  model: "llama3.2",
  input: { messages: [{ role: "user", content: "Hello" }] },
});
const summary = response.toDialect("summary");
```

A custom service needs `fromBaseline(output)`. Add `toBaseline(input)` when the service should also accept its own request shape.

## Conversion limits

The baseline retains thinking signatures, cache controls and accounting, tool calls and results, multimodal sources, reasoning settings, structured output, multiple candidates, and Ollama runtime settings and timings. Support for sending those features depends on the provider.

Built-in request converters throw `UnsupportedFeatureError` for unrepresentable features. Native extensions are sent only to the matching wire API. Response projections can omit fields absent from the target schema, but converting multiple candidates into a single-message schema throws rather than silently dropping candidates. Invalid tool argument JSON throws when the target requires parsed JSON.

Unknown token counts remain `null` in canonical usage. Anthropic projection throws if required usage counts are unknown; OpenAI projection can omit optional usage. Some native fields may be synthesized when the source lacks them, such as the OpenAI creation timestamp.
