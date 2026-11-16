<p align="center">
  <img src="assets/nekosearch.png" alt="NekoSearch cat reading a book" width="240" />
</p>

<h3 align="center">NekoSearch</h3>
<p align="center">A local, read-only MCP server for searching and fetching NestJS documentation.</p>

---

### Description

NekoSearch gives AI assistants local access to versioned NestJS documentation. It ships validated indexes for NestJS 11 and 12 and returns relevant sections with canonical source URLs and upstream revisions. Connect over stdio or loopback Streamable HTTP; the selected index is read-only, and the server does not download documentation at runtime. NekoSearch is independently maintained and is not affiliated with NestJS.

The reusable engine handles document discovery, parsing, indexing, and retrieval independently of any documentation source. A separate NestJS integration builds the v11 and v12 indexes. The distributable package bundles the engine with those indexes for offline use.

---

### Installation

Prerequisites:

- Node.js 24.15 or newer
- npm

From the project directory:

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

For this NestJS docs example, select v12 by setting its matching SQLite index and manifest. Use the corresponding v11 paths to serve NestJS 11:

```sh
export DOCUMENTATION_INDEX_PATH="$PWD/data/documentation-v12.sqlite"
export DOCUMENTATION_INDEX_MANIFEST_PATH="$PWD/data/documentation-v12.manifest.json"
npm run start:stdio
```

For the HTTP transport, use the same environment variables and run:

```sh
npm run start:prod
```

The HTTP server listens at `http://127.0.0.1:3000/mcp` by default. Set `PORT` to change the port. The optional `NESTJS_DOCS_MCP_ALLOWED_HOSTS` variable accepts a comma-separated host list and defaults to `localhost,127.0.0.1,[::1]`. Set `DEBUG=1` to log MCP call timing to stderr.

---

### MCP Tools

| Tool          | Arguments                                       | Behavior                                                                                    |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `search_docs` | `query`, optional `limit` (1–10)                | Returns ranked sections with document IDs, source URLs, and revisions.                      |
| `fetch_docs`  | `documentId`, optional `sectionId` and `cursor` | Returns bounded Markdown for a document or section. Use IDs and cursors returned by search. |

The selected index determines the documentation version; tool arguments cannot change it. Both tools are read-only.

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
```

The package includes the MCP server, reusable documentation engine, v11/v12 indexes, and license notices. GitHub Actions validates and releases changed index bundles; it does not publish npm packages. A published npm package contains a fixed index snapshot, so newer bundles reach users through a later npm release.

---

### License

[MIT](LICENSE)
