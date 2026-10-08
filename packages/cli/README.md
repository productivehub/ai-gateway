# productiveHub AI Gateway CLI

`@productivehub/ai-gateway-cli` installs the `ai-gateway` command, part of the
[productiveHub AI Gateway](../../README.md). It is MIT-licensed, created and
maintained by [Segev Shmueli](https://github.com/segevsh) for
[productiveHub](https://github.com/productivehub).

Run completions, list models and accounts, read an account's remaining allowance, or
start the HTTP server from a terminal. The CLI is a client of the
[AI gateway API](../api/README.md) contract: it calls the API in-process, or a
running server with `--url`.

## Usage

```sh
ai-gateway complete writer "Summarize this repo in one line"
git diff | ai-gateway complete claude-sonnet-5-5 --key claude-work -s "Review this diff"
ai-gateway complete llama3.2 hi --provider ollama --dialect openai   # native OpenAI JSON
ai-gateway complete coder --input request.json --json               # full BridgeInput in, envelope out
ai-gateway models --key cloud          # provider catalog, one model ID per line
ai-gateway models --configured         # alias, key, provider, native model
ai-gateway keys                        # account, provider, base URL
ai-gateway allowance --key cloud       # remaining quota and usage rows
ai-gateway allowance --provider ollama-cloud --json   # full allowance body
ai-gateway serve --port 8787           # same as `pnpm start`
```

Without `--url`, each command builds the same app as `createDefaultGateway()` from
`--config` / `AI_GATEWAY_CONFIG` or the provider environment variables, and sends
the request to it in-process; no socket is opened. With `--url` (or `AI_GATEWAY_URL`)
it sends the identical request to a running server, for example the director's
`http://localhost:3000/api/ai`. Credentials then stay on the server.

`complete` takes the prompt from its arguments or, when omitted, from stdin.
`--system`, `--max-tokens` and `--temperature` fill the canonical `BridgeInput`;
`--input file.json` (or `-` for stdin) supplies the whole input instead.
`--key`, `--provider` and `--dialect` are the [HTTP query parameters](../api/README.md#http-contract).
For the `bridge` dialect it prints the reply text; for other dialects it prints the
`output` JSON; `--json` prints the whole response envelope. Lists are
tab-separated, or JSON with `--json`. Exit codes are `0` on success, `1` for a
request or provider error and `2` for a usage error; errors go to stderr.

`allowance` prints the selected account's quota as tab-separated rows: an
`available` row when the provider reports one, then one row per window (`id`,
`kind`, remaining and limit amounts, remaining percent, reset time) and finally the
`usage` period (`from`, `until`, requests, cost) when the provider reports one.
`--json` prints the whole response body instead. A provider that cannot report an
allowance exits `1` with the HTTP 501 message.

Hosts can embed the same runner: `import { runCli } from "@productivehub/ai-gateway-cli"`
resolves to the exit code and accepts injected stdio, environment, `fetch` or app.

## Configuration

The CLI reads the API's [`GatewayConfig`](../api/README.md#json-startup-config-and-named-accounts)
and environment variables. Copy `gateway.config.example.json` to `gateway.config.json`
and `.env.example` to `.env`, then replace the placeholder model IDs.

| Environment variable | Option | Default |
| --- | --- | --- |
| `AI_GATEWAY_CONFIG` | `--config` | No file; configured environment accounts only |
| `AI_GATEWAY_URL` | `--url` | None; the CLI runs the API in-process |
| `AI_GATEWAY_PORT` | `serve --port` | 8787 |
| `AI_GATEWAY_HOSTNAME` | `serve --hostname` | 127.0.0.1 |

Provider credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`,
`OLLAMA_BASE_URL`, ...)
and the other `AI_GATEWAY_*` settings are documented in the
[API configuration](../api/README.md#configuration).

## Run from a checkout

```sh
git submodule update --init --recursive
pnpm install
pnpm --filter @productivehub/ai-gateway-cli... build
cd oss/ai-gateway/packages/cli
cp .env.example .env
pnpm start                    # serve on Node
pnpm cli keys                 # any command on Node
# or:
deno task start               # serve on Deno, using native Deno.serve
deno task cli keys            # any command on Deno
```

## Development

```sh
pnpm -F @productivehub/ai-gateway-cli test
pnpm -F @productivehub/ai-gateway-cli typecheck  # builds the api package first
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md), [AUTHORS.md](../../AUTHORS.md), and [LICENSE](./LICENSE).
