---
title: Development Setup
description: Install the npm workspace, build NekoSearch, run checks, and develop or prepare the independent VitePress documentation website.
---

# Development Setup

## Install and build

Use a supported Node 24 release matching the package's engine range. The repository includes `.nvmrc` with major version 24.

```sh
git clone https://github.com/rafaself/neko-search.git
cd neko-search
nvm use
npm ci
npm run build
```

The npm workspaces include the documentation engine, indexer, and private website. Keep `package-lock.json` as the dependency lockfile.

The root build compiles the engine, indexer, and production CLI, and prepares the builder runtime needed by CLI commands. It does not download NestJS documentation or build the website.

```sh
npm run start:nekosearch -- --help
npm test
```

The Jest suite builds the application through its global setup. It includes unit, integration, and stdio end-to-end coverage. See [Contributing](./contributing.md#required-validation) for the required completion checks.

## Documentation website

```sh
npm run docs:site:dev
```

Open the local URL printed by VitePress. Production build and preview are separate:

```sh
npm run docs:site:build
npm run docs:site:check
npm run docs:site:preview
```

The source is Markdown under `apps/docs-site/docs`, with VitePress configuration and a small theme extension in the app's `.vitepress` directory. Static assets live in the app's `public` directory. Output is `apps/docs-site/.vitepress/dist` and is ignored by Git.

`docs:site:check` checks the generated HTML's local navigation, fragment targets, and asset references. Run it after building. Browser checks are still needed for search, mobile menus, and appearance.

VitePress and Vue are development dependencies of the private site workspace. They are not CLI runtime dependencies. The site uses VitePress's built-in local search; no search account, API key, backend, or database service is needed.

## Configure a future deployment

| Environment variable | Default | Purpose                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `DOCS_SITE_BASE`     | `/`     | Absolute deployment path, with leading and trailing slashes                |
| `DOCS_SITE_URL`      | Unset   | HTTP(S) deployment origin, without a path, credentials, query, or fragment |

For example, this POSIX-shell command uses an illustrative domain, not an existing NekoSearch deployment:

```sh
DOCS_SITE_URL=https://docs.example.com DOCS_SITE_BASE=/nekosearch/ npm run docs:site:build
DOCS_SITE_BASE=/nekosearch/ npm run docs:site:check
DOCS_SITE_BASE=/nekosearch/ npm run docs:site:preview
```

With an origin configured, the build emits canonical URLs, absolute sharing-image URLs, and a sitemap containing the base path. Without an origin, it omits those deployment-specific URLs and the sitemap. Titles, descriptions, theme metadata, and the local favicon remain configured.

Keep the same base when building, checking, and previewing. The output uses `.html` page URLs so a future static host does not need extensionless-route rewrites. No deployment workflow is configured by the site.

## Existing snapshot scripts

The existing root commands `docs:build`, `docs:ingest`, `docs:build:mcp`, and `search:index` operate on indexed documentation. They are separate from the `docs:site:*` website scripts.

Use the public CLI's [`build`](../cli/commands.md#build) for portable local snapshots. Contributor-level indexer commands expose the specialized ingestion/build pipeline; inspect their command handlers and configuration schemas before changing them. Product website development does not require rebuilding external documentation snapshots.
