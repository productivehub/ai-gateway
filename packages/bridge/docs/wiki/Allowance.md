# Allowance

`bridge.getAllowance({ provider })` reads remaining quota from one registered
provider or named account. It reports upstream balances and plan windows;
it does not calculate completion charges or enforce a local spending budget.

```ts
import { createBridge, createBuiltInProviders } from "@productivehub/ai-bridge";

const bridge = createBridge({ providers: createBuiltInProviders() });
const allowance = await bridge.getAllowance({ provider: "deepseek" });
console.log(allowance.available, allowance.primary, allowance.windows);
console.log(allowance.usage, allowance.meta);
```

Configure `DEEPSEEK_API_KEY` before running this example. See
[Configuration](./Configuration.md) for other connections and named accounts.

## Response contract

| Field | Meaning |
| --- | --- |
| `provider` | Registered provider/account name |
| `available` | Provider's verdict (`true` or `false`), or `null` when unreported |
| `primary` | Window that gates calls, or `null` when there are no windows |
| `windows` | Reported money or subscription plan windows |
| `usage` | Optional report period, requests, cost, tokens, and time buckets |
| `raw` | Native allowance payloads |
| `meta` | Request timestamps and elapsed duration |

Each window has a stable `id`, a `kind` (`money` or `plan`), optional `label`,
optional `limit`, `remaining` and `used` amounts, a `remainingFraction` in 0..1
or `null`, and an optional `period` with `from`, `until` or `resetsAt`. Monetary
amounts use `BridgeCost`: a currency code and an integer in minor units.
Omitted values mean unreported, rather than zero.

## Provider support

DeepSeek reads `/user/balance` using its own credentials and endpoint. Each
reported currency becomes a window with `remaining` derived from `total_balance`;
no limit or usage report is inferred. `available` preserves `is_available`.

Ollama Cloud reads `/api/balance` and `/api/usage` concurrently with a default
15-second timeout. A failing usage endpoint omits only the optional usage report.
Negative balances read as zero. Its plan windows and money balances share the
same canonical contract.

OpenAI, Anthropic, Jev and local Ollama do not report allowance. Calling an adapter
without support throws `UnsupportedFeatureError` with `feature === "allowance"`;
unknown registry names throw `UnknownProviderError`.

## Custom providers

Implement `getAllowance(): Promise<ProviderAllowanceResponse>` alongside
`complete`. The bridge adds the registry name and timing; retain native data in
`raw` and map unreported values to `null` or omit optional fields.

Use `toMinorUnits(value, fractionDigits = 2)` for decimal monetary values. It
rounds half-up using decimal arithmetic: `toMinorUnits("1.005")` returns `101`.
Use the currency's fraction digits when they differ from two. See
[Costs](./Costs.md) and [API Reference](./API-Reference.md) for related contracts.
