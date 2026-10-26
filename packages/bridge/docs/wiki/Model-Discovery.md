# Model Discovery

Use `bridge.listModels({ provider })` to query the models reported by one registered provider or account. All built-in adapters convert their catalogs into the same `BridgeModel` type.

```ts
import { createBridge, OllamaProvider, type BridgeModelsResponse } from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: { local: new OllamaProvider({ baseURL: "http://localhost:11434" }) },
});

const catalog: BridgeModelsResponse = await bridge.listModels({ provider: "local" });
for (const model of catalog.models) {
  console.log(model.id, model.name, model.costs);
}
console.log(catalog.provider, catalog.meta);
```

## Catalog envelope

| Field | Meaning |
| --- | --- |
| `provider` | The registered provider/account name used for the query |
| `models` | Consistent `BridgeModel[]` entries |
| `raw` | Native list payloads, excluding SDK client and request state |
| `meta` | Bridge-observed `startedAt`, `endedAt`, and `durationMs` |

## Model fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Identifier accepted by that provider |
| `raw` | Yes | Native metadata, including capabilities without a canonical equivalent |
| `name` | No | Provider-reported display name |
| `createdAt` | No | Creation timestamp |
| `modifiedAt` | No | Modification timestamp, distinct from creation |
| `ownedBy` | No | Provider-reported owner |
| `maxInputTokens` | No | Reported maximum input tokens |
| `maxOutputTokens` | No | Reported maximum output tokens |
| `sizeBytes` | No | Model size in bytes |
| `costs` | No | Known pricing using `BridgeModelCosts`; see [Costs](./Costs.md) |

Absent metadata is not inferred. OpenAI's Unix creation timestamps are converted to ISO 8601. Anthropic supplies display names, creation times, and token limits when reported. Ollama supplies names, modification timestamps, and sizes when reported. Jev maps TypeSafe model `name` to `id`/`name` and `release_date` to `createdAt`, retaining descriptions in `raw`. It queries `/v1/models`; the catalog may list aliases while accepting versioned IDs that are absent from the list.

Anthropic discovery follows every page and returns native pages under `raw.pages`. A failure on a later page rejects the request instead of returning a partial catalog. OpenAI retains its native list data; both Ollama adapters use `/api/tags`.

DeepSeek queries `/models` directly with its own key and base URL. Its current
catalog does not supply creation timestamps, pricing or token limits, so those
fields remain absent.

xAI queries `/models` the same way and maps `context_length` to `maxInputTokens`.
Its text-token prices (USD cents per 100M tokens) become `costs` when they are a
whole number of cents per million tokens; see [Costs](./Costs.md). Mistral queries
`/v1/models`, mapping `name`, `owned_by`, `created` and `max_context_length`.

Catalogs can be empty. Local Ollama reports installed models; cloud discovery reports the cloud host's catalog. Discovery does not guarantee that every listed model supports chat completions.

Discovery returns canonical metadata and has no `toDialect` conversion. Custom providers must return `ProviderModelsResponse` from their optional `listModels` method. Adapters without discovery throw `UnsupportedFeatureError`; unknown registry names throw `UnknownProviderError`.
