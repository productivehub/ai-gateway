# productiveHub AI Gateway

An MIT-licensed AI gateway over [`@productivehub/ai-bridge`](https://github.com/productivehub/ai-bridge): one HTTP
endpoint for every configured model provider, with named accounts, model aliases and a CLI,
created and maintained by [Segev Shmueli](https://github.com/segevsh) for
[productiveHub](https://github.com/productivehub).

| Package | Folder | What |
| --- | --- | --- |
| [`@productivehub/ai-gateway-api`](./packages/api/README.md) | `packages/api` | Mountable Hono HTTP API and standalone Node/Deno listener |
| [`@productivehub/ai-gateway-cli`](./packages/cli/README.md) | `packages/cli` | `ai-gateway` command: completions, model and account discovery, `serve` |

The packages share one config format (`GatewayConfig`) and one HTTP contract.
The CLI never calls the bridge directly; it sends HTTP requests to the API app
in-process, or to a running server with `--url`.

```sh
ai-gateway complete writer "Summarize this repo in one line"
ai-gateway serve --config ./gateway.config.json
```

## Repository layout

Each package lives in `packages/<name>` with its own `package.json`, `tsconfig.json`
(extending the shared `tsconfig.base.json`), `src/`, `test/`, `README.md` and
`LICENSE`. Packages depend on each other through `workspace:*` and TypeScript
project references.

The repository is developed inside the
[phub-director](https://github.com/productivehub) workspace, which links the
bridge and these packages. The packages link the bridge through `workspace:*`;
building them outside that workspace requires the bridge package alongside them.
Public npm publishing is configured but has not been performed.

```sh
pnpm install                                   # from the director root
pnpm --filter "@productivehub/ai-gateway-cli..." build
pnpm -F @productivehub/ai-gateway-api test
pnpm -F @productivehub/ai-gateway-cli test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), [AUTHORS.md](./AUTHORS.md), and [LICENSE](./LICENSE).
