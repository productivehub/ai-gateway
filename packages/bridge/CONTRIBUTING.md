# Contributing to @productivehub/ai-bridge

Contributions to providers, dialects, documentation and the canonical contract are welcome. See [AUTHORS.md](./AUTHORS.md) for ownership and project credits.

## Local setup

Use Node.js 22 or later and the pnpm version specified in `package.json`. From a standalone checkout:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Tests use injected transports and do not need real API keys or running model servers.

Inside the `phub-director` monorepo, run `pnpm install` at the monorepo root and use `pnpm -F @productivehub/ai-bridge <command>`.

## Implementation conventions

- Use TypeScript and ESM with `.js` extensions in relative imports.
- Keep the canonical types in `src/baseline.ts` and the public contracts in `src/types.ts` independent of vendor SDKs.
- Put provider implementations in `src/providers/` and dialect converters in `src/dialects/`.
- Providers accept and return the canonical baseline. Caller input and response dialect conversion belong to dialect services.
- Keep registries injectable and local to each bridge instance. Custom providers and dialects must not require edits to a central name union.
- Preserve native response data in `raw` and unrepresented fields in canonical extensions. Reject unsupported request conversions explicitly.
- For behavior changes, add focused tests using injected transports. Include compile-time checks when changing type inference or public contracts.

Read the [README](./README.md) for public API examples and conversion limits, and the [architecture notes](./docs/ARCHITECTURE.md) for the design.

## Proposing changes

Describe the problem, resulting behavior and relevant validation in your pull request. Include a before/after example when changing public APIs. Keep documentation aligned with the final behavior and avoid committing API keys or environment files.

## License

This package and its contributions are distributed under the [MIT license](./LICENSE). Preserve the license and copyright notices when redistributing the software.
