# Maintaining the Wiki

## Source pages

The source of this wiki lives in [docs/wiki](https://github.com/productivehub/ai-gateway/tree/main/packages/bridge/docs/wiki) in the `packages/bridge` folder of the gateway repository. Edit those Markdown files alongside API changes so documentation can be reviewed through normal pull requests. Update `Home.md` and `_Sidebar.md` when adding or renaming a page.

The maintainer is [Segev Shmueli](https://github.com/segevsh) (`@segevsh`). See [CONTRIBUTING.md](https://github.com/productivehub/ai-gateway/blob/main/packages/bridge/CONTRIBUTING.md), [AUTHORS.md](https://github.com/productivehub/ai-gateway/blob/main/packages/bridge/AUTHORS.md), and the [MIT license](https://github.com/productivehub/ai-gateway/blob/main/packages/bridge/LICENSE).

## Publishing

These pages are read where they live, in the repository; there is no separate GitHub Wiki to export to. Relative links between pages work on GitHub and in any Markdown viewer. The bridge's earlier GitHub Wiki on `productivehub/ai-bridge` was frozen when that repository was archived and is no longer updated.

## Validate changes

Check links, confirm examples against the current public contracts, and ensure credentials in examples are environment references or placeholders. Validate relevant TypeScript examples and run the checks required by any accompanying code change. The source pages document bridge behavior; server-only features should be documented with the API wrapper.
