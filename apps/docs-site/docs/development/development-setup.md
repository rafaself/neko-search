---
title: Development Setup
description: Install the npm workspace, build NekoSearch, run checks, and develop or prepare the independent VitePress documentation website.
---

# Development Setup

## Install and build

Use a supported Node 24 release matching the package's engine range. The repository includes `.nvmrc` with major version 24.

```sh
git clone https://github.com/rafaself/nekosearch.git
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

## Deployment configuration

| Environment variable | Default                        | Purpose                                                                    |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `DOCS_SITE_BASE`     | `/`                            | Absolute deployment path, with leading and trailing slashes                |
| `DOCS_SITE_URL`      | `https://nekosearch.pages.dev` | HTTP(S) deployment origin, without a path, credentials, query, or fragment |

For a local build targeting a project site under a subpath, override both values:

```sh
DOCS_SITE_URL=https://docs.example.com DOCS_SITE_BASE=/nekosearch/ npm run docs:site:build
DOCS_SITE_BASE=/nekosearch/ npm run docs:site:check
DOCS_SITE_BASE=/nekosearch/ npm run docs:site:preview
```

The production build emits canonical URLs, absolute sharing-image URLs, and a sitemap for `https://nekosearch.pages.dev/`. `DOCS_SITE_URL` can override that origin for a preview deployment.

Keep the same base when building, checking, and previewing. The output uses `.html` page files so static hosts can serve clean routes without rewrite rules.

## Publish with Cloudflare Pages

The **Publish documentation** GitHub Actions workflow is manual. It builds and checks the site, creates the Cloudflare Pages Direct Upload project named `nekosearch` on the first run if needed, then uploads the static output with Wrangler. It only publishes the `main` branch and never deploys on a push.

Before the first deployment:

1. Create a Cloudflare API token with **Account → Cloudflare Pages → Edit** permission.
2. In the GitHub repository, add Actions secrets named `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with the matching Cloudflare values.

Then open **Actions → Publish documentation → Run workflow**, choose `main`, and start the run. Cloudflare must have the `nekosearch` project name available for the site to receive the `nekosearch.pages.dev` address. Cloudflare Direct Upload projects cannot later be switched to Git integration, so keep this project on Direct Upload for manual workflow publishing. See Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) and [GitHub Actions setup](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

## Existing snapshot scripts

The root commands `docs:build` and `docs:build:mcp` build package documentation snapshots and honor `nekosearch.yaml` or `NEKOSEARCH_CONFIG` for optional local embeddings. Semantic Search is disabled by default; enabling it requires the already installed model and optional inference runtime. The lower-level `docs:ingest` and `search:index` commands remain corpus/index maintenance tools. These commands are separate from the `docs:site:*` website scripts.

Use the public CLI's [`build`](../cli/commands.md#build) for portable local snapshots. Contributor-level indexer commands expose the specialized ingestion/build pipeline; inspect their command handlers and configuration schemas before changing them. Product website development does not require rebuilding external documentation snapshots.
