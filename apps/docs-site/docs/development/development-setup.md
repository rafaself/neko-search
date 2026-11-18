---
title: Development Setup
description: Install the npm workspace, build NekoSearch, run checks, and develop or prepare the independent VitePress documentation website.
---

# Development Setup

## Install and build

Use a supported Node 24 release matching the package's engine range. The repository includes `.nvmrc` with major version 24.

```sh
git clone https://github.com/rafaself/nekosearch.git
cd nekosearch
nvm use
npm ci
npm run build
```

The npm workspaces include the published NekoSearch CLI, private documentation engine, and private website. Keep `package-lock.json` as the dependency lockfile.

The root build compiles the documentation engine and the NekoSearch CLI. The CLI imports the engine’s snapshot builder and keeps its NestJS recipes under `apps/nekosearch/src/sources`. It does not download NestJS documentation or build the website.

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

The **Publish documentation** GitHub Actions workflow is manual. It builds and checks the site, then uploads the static output to the existing Cloudflare Pages Direct Upload project named `nekosearch` with Wrangler. It only publishes the `main` branch and never deploys on a push.

Before the first deployment:

1. Confirm the `nekosearch` Pages project exists in the target account.
2. Create a Cloudflare API token with **Account → Cloudflare Pages → Edit** permission.
3. In the GitHub repository, add Actions secrets named `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with the matching Cloudflare values.

Then open **Actions → Publish documentation → Run workflow**, choose `main`, and start the run. Cloudflare must have the `nekosearch` project name available for the site to receive the `nekosearch.pages.dev` address. Cloudflare Direct Upload projects cannot later be switched to Git integration, so keep this project on Direct Upload for manual workflow publishing. See Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) and [GitHub Actions setup](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

## Existing snapshot scripts

Use `docs:build` for contributor snapshot builds that honor the local Semantic Search configuration. Use `docs:build:mcp` to regenerate the bundled protocol reference as a lexical snapshot from `apps/nekosearch/content/mcp-protocol`. Pass `-- --output <directory>` to `npm run docs:build:mcp` to inspect a regenerated snapshot before updating the bundled copy. The `docs:ingest` and `search:index` commands are corpus and index maintenance tools. These commands are separate from the `docs:site:*` website scripts.

Use the public CLI's [`build`](../cli/commands.md#build) for portable local snapshots. Contributor commands live in `apps/nekosearch/src/maintenance`. To build and verify the npm tarball, run `npm run package:pack -- --pack-destination /tmp`. Product website development does not require rebuilding external documentation snapshots.
