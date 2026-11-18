# Contributing to NekoSearch

Use a compatible Node.js version and npm. The repository includes `.nvmrc` for the development baseline and tracks one root `package-lock.json`.

```sh
nvm use
npm ci
npm run build
npm run check
```

- `src/apps/nekosearch` contains the CLI, MCP server, catalog, setup, and local inference.
- `apps/docs-indexer` builds documentation snapshots and contains the NestJS source adapter.
- `packages/documentation-engine` contains the shared corpus, indexing, and retrieval code.
- `apps/docs-site` contains the product documentation and website.
- `test` contains shared fixtures and tests. `scripts` contains build, release, and evaluation tools.

Run `npm run docs:site:build` followed by `npm run docs:site:check` for website changes. See the [development setup](apps/docs-site/docs/development/development-setup.md) and [contribution guide](apps/docs-site/docs/development/contributing.md) for details.

For changes affecting the published CLI, run the package checks before release. They install the tarball in a clean project and exercise its MCP server over stdio. The real Qwen3 workflow runs separately from regular CI.
