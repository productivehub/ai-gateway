# Contributing

Maintained by [Segev Shmueli](https://github.com/segevsh) for
[productiveHub](https://github.com/productivehub).

Use TypeScript, ESM and `.js` relative imports. Keep the transport independent
of particular providers or dialects; register new implementations in the bridge
and inject that bridge into `createGateway`. Keep app creation free of sockets
so hosts can mount it. Listener and CLI changes should retain Node and Deno support.
The CLI is a client of the HTTP contract: it sends requests to the app or a
`--url` server and never calls the bridge directly.

Each package lives in `packages/<name>`; new SDK packages follow the same layout
(see the repository README). From the director workspace root, run `pnpm install`
and `pnpm --filter "@productivehub/ai-gateway-cli..." build`, then run
`pnpm -F <package> typecheck` and `pnpm -F <package> test` for each package you
changed. Include meaningful tests for behavior changes and update the package
README for contract, command or configuration changes. For listener changes, also
run the Node and Deno runtime smoke checks documented in the api README. Use mocked
providers; do not commit credentials.

Contributions are made under the project's [MIT license](./LICENSE).
