# Maintaining the Wiki

## Source pages

The source of this wiki lives in [docs/wiki](https://github.com/productivehub/ai-bridge/tree/main/docs/wiki) in the bridge repository. Edit those Markdown files alongside API changes so documentation can be reviewed through normal pull requests. Update `Home.md` and `_Sidebar.md` when adding or renaming a page.

The maintainer is [Segev Shmueli](https://github.com/segevsh) (`@segevsh`). See [CONTRIBUTING.md](https://github.com/productivehub/ai-bridge/blob/main/CONTRIBUTING.md), [AUTHORS.md](https://github.com/productivehub/ai-bridge/blob/main/AUTHORS.md), and the [MIT license](https://github.com/productivehub/ai-bridge/blob/main/LICENSE).

## Publish to GitHub Wiki

GitHub stores the published Wiki in a separate Git repository. Its first page must be created using the GitHub Wiki interface before that repository can be cloned. On [the bridge Wiki](https://github.com/productivehub/ai-bridge/wiki), create and save a page named `Home` once. See [GitHub's wiki instructions](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages).

Once initialized, run these commands from a bridge repository checkout with GitHub write access:

```sh
git clone https://github.com/productivehub/ai-bridge.wiki.git /tmp/productivehub-bridge-wiki
node scripts/export-wiki.mjs /tmp/productivehub-bridge-wiki
git -C /tmp/productivehub-bridge-wiki add -- '*.md'
git -C /tmp/productivehub-bridge-wiki commit -m "Update bridge wiki pages"
git -C /tmp/productivehub-bridge-wiki push
```

For an existing wiki checkout, pull its latest changes before exporting. The exporter copies the source Markdown pages, including `_Sidebar.md` and `_Footer.md`, and changes local page links to GitHub Wiki URLs. Source links work in the main repository; exported links work in the Wiki.

The exporter overwrites matching page files in the destination and leaves unrelated files alone. Delete obsolete wiki pages explicitly when removing or renaming a source page. It does not commit or push, and no automatic publishing workflow is configured.

## Validate changes

Check links, confirm examples against the current public contracts, and ensure credentials in examples are environment references or placeholders. Validate relevant TypeScript examples and run the checks required by any accompanying code change. The source pages document bridge behavior; server-only features should be documented with the API wrapper.
