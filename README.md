<p align="center">
  <img src="assets/nekosearch.png" alt="NekoSearch cat reading a book" width="240" />
</p>

<h3 align="center">NekoSearch</h3>
<p align="center">A local, read-only MCP server for searching versioned documentation.</p>

---

### Description

NekoSearch gives AI assistants local stdio access to versioned documentation. It ships validated indexes for NestJS 11 and 12 and a pinned Model Context Protocol specification snapshot. You can add other validated snapshots to a local catalog. Searches select one source and version at a time, return canonical source URLs and revisions, and never combine rankings across indexes. The indexes are read-only while serving, and the server does not download documentation at runtime. NekoSearch is independently maintained and is not affiliated with NestJS or the Model Context Protocol maintainers.

The reusable engine handles document discovery, parsing, indexing, and retrieval independently of any documentation source. Separate integrations build the NestJS and MCP protocol indexes. The distributable package bundles the retrieval engine with validated indexes for offline use.

---

### Installation

Prerequisites:

- Node.js 24.15 or newer
- npm

Install the published package to use the `nekosearch` command:

```sh
npm install --global nestjs-docs-mcp
```

To work on the project from its directory:

```sh
nvm use
npm ci
```

Prepare the documentation indexes from the current upstream revisions:

```sh
npm run package:verify -- --regenerate
```

This validates and stages the v11 and v12 indexes in `data/`. You can also pass an extracted GitHub index bundle with `--bundle-dir <directory>`. Index generation needs network access; the MCP server itself does not download documentation or update indexes.

---

### Quick Start

Inspect the bundled indexes:

```sh
nekosearch list
```

The catalog displays each documentation source, version, source revision, and whether it is bundled or installed. Add a validated snapshot directory produced by the documentation indexer with `corpus.json`, `index.sqlite`, and `manifest.json`:

```sh
nekosearch add --from /path/to/snapshot-directory
nekosearch list
nekosearch serve
```

When running from the repository after building, use:

```sh
npm run start:nekosearch -- serve
```

`nekosearch serve` opens bundled and installed indexes read-only. It needs no index path settings and does not open a network listener. Set `DEBUG=1` to log MCP tool timing to stderr.

---

### MCP Tools

| Tool          | Arguments                                                            | Behavior                                                                                      |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `search_docs` | `query`, `source`, `version`, optional `limit` (1–10)                | Returns ranked sections from exactly one index with source, version, IDs, URLs, and revision. |
| `fetch_docs`  | `source`, `version`, `documentId`, optional `sectionId` and `cursor` | Fetches from the exact index identified by search results; returns bounded Markdown.          |

Use the `source` and `version` from `search_docs` when calling `fetch_docs`. MCP tools accept documentation selectors and result IDs; filesystem paths are only accepted by the local CLI `add` command.

---

### Development

Run formatting, lint, type checks, and tests:

```sh
npm run check
npm run build
```

Verify the npm tarball from an extracted index bundle, or regenerate indexes and verify them:

```sh
npm run package:verify -- --bundle-dir /path/to/extracted/documentation-indexes
npm run package:verify -- --regenerate
npm run docs:build:mcp
```

The published package contains the stdio MCP server, the retrieval portion of the documentation engine, the bundled snapshots, and license notices. Build and test tools, the indexer, Markdown parser, and HTTP development server remain repository-only. GitHub Actions validates and releases changed NestJS index bundles; it does not publish npm packages. A published npm package contains fixed bundled snapshots; newer snapshots can be installed locally with `nekosearch add`.

---

### License

[MIT](LICENSE)
