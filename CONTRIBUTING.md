# Contributing to NekoSearch

Use a compatible Node.js version and npm. The repository includes `.nvmrc` for the development baseline and tracks one root `package-lock.json`.

```sh
nvm use
npm ci
npm run build
npm run check
```

- `apps/nekosearch` is the published CLI and MCP server. It owns setup, the catalog, local inference, NestJS source recipes, and the bundled MCP reference.
- `packages/documentation-engine` owns snapshot building, corpus schemas, indexing, and retrieval.
- `apps/docs-site` contains the product documentation and website.
- `test` contains shared fixtures and tests. `scripts` contains build, release, and evaluation tools.

Run `npm run docs:site:build` followed by `npm run docs:site:check` for website changes. See the [development setup](apps/docs-site/docs/development/development-setup.md) and [contribution guide](apps/docs-site/docs/development/contributing.md) for details.

For changes affecting the published CLI, run `npm run package:pack -- --pack-destination /tmp` before release. This command installs the tarball in a clean project and exercises its MCP server over stdio. The real Qwen3 workflow runs separately from regular CI.
