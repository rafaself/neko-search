<p align="center">
  <img src="assets/nekosearch.png" alt="NekoSearch cat reading a book" width="240" />
</p>

<h3 align="center">NekoSearch</h3>
<p align="center">A local, read-only MCP server for searching documentation snapshots.</p>

---

NekoSearch builds and serves local documentation indexes. Bring your own Markdown or MDX files, install a curated source such as NestJS, then search selected sources together or individually. Results stay grouped by source, and each fetch uses one exact source selector. The server runs over stdio, opens SQLite indexes read-only, and does not fetch documentation while serving.

NekoSearch is a generic documentation server. NestJS is an optional curated example; no NestJS index is bundled or required. The package includes a small summary of the MCP protocol specification as a documentation source. That reference content is separate from NekoSearch itself, which is an MCP server.

## Install

Requirements: Node.js 24.15 or newer and npm.

```sh
npm install --global nestjs-docs-mcp
nekosearch --help
```

Installing the npm package does not download or build NestJS documentation. Use `nekosearch list` to see the sources available locally; a new catalog contains the bundled MCP protocol summary and no NestJS source.

## Build and install your documentation

Build a snapshot from a local Markdown or MDX directory, then install it into your catalog:

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
nekosearch add --from ./snapshots/my-api
nekosearch list
nekosearch serve
```

`build` scans local Markdown and MDX files and writes `corpus.json`, `index.sqlite`, and `manifest.json` to the output directory you choose. It does not install the snapshot or make network requests. MDX is parsed as static documentation; it is never compiled or executed.

`add --from` validates and installs an existing snapshot directory. It also works with snapshots built by another tool, provided they contain the same three files and a supported manifest. The installed SQLite database is stored under the user catalog:

- Linux and macOS: `$XDG_DATA_HOME/nekosearch/snapshots/` or `~/.local/share/nekosearch/snapshots/` when `XDG_DATA_HOME` is unset.
- Windows: `%LOCALAPPDATA%\nekosearch\snapshots\`.

## Optional curated source: NestJS

NestJS 11 and 12 can be installed on demand:

```sh
nekosearch add nestjs@12
nekosearch update nestjs@12
nekosearch status
nekosearch status nestjs@12
nekosearch status nestjs@12 --check-upstream
```

`add` and `update` require network access to GitHub over HTTPS. NekoSearch resolves the curated official source ref to a concrete commit, downloads supported documentation files from that commit without Git, applies the NestJS-specific Markdown transformation, and builds and validates the SQLite snapshot locally. The resolved commit and ref are recorded in its manifest. Updates stay within the requested major and activate only after the replacement snapshot passes validation; a failed update leaves the active snapshot in place.

The current recipes use the official `nestjs/docs.nestjs.com` repository: the `11.0.0` tag for NestJS 11 and the `master` branch for NestJS 12. The NestJS 12 recipe checks its migration guide to ensure that `master` still describes the v11-to-v12 migration. If a configured ref cannot be resolved, installation fails instead of selecting another ref.

`nekosearch status` is offline by default. With no selector it shows the CLI version, catalog readability, and every available bundled or installed snapshot, including its active revision, origin, and tracking state. A selector shows only that snapshot and validates only its files. `status nestjs@12 --check-upstream` makes a read-only network check for that tracked recipe; it resolves the configured ref and compares commit IDs without downloading documentation or changing the catalog. Results distinguish `current`, `changed`, `untracked`, and `check failed`. A network or ref-resolution failure is reported as `check failed`, never as current. A snapshot pinned to an immutable commit, or installed with `add --from`, does not track future revisions.

## Network access and serving

| Command                                                 | Network access | What it does                                                                      |
| ------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `nekosearch build ...`                                  | No             | Builds a snapshot from local files at the chosen output path.                     |
| `nekosearch add --from ...`                             | No             | Validates and installs a local snapshot.                                          |
| `nekosearch list`                                       | No             | Lists bundled and installed snapshots.                                            |
| `nekosearch status [<source@version>]`                  | No             | Shows catalog and snapshot state without contacting upstream sources.             |
| `nekosearch status [<source@version>] --check-upstream` | Yes            | Resolves selected tracked refs only; does not download docs or write the catalog. |
| `nekosearch add nestjs@11` / `nestjs@12`                | Yes            | Fetches the selected curated source over HTTPS and builds it locally.             |
| `nekosearch update nestjs@11` / `nestjs@12`             | Yes            | Resolves and builds the requested major's latest curated commit.                  |
| `nekosearch serve`                                      | No             | Serves search and fetch tools over stdio using read-only SQLite connections.      |
| `nekosearch mcp configure codex`                        | No             | Registers the local executable with the installed Codex CLI.                      |

`serve` does not open a network listener, fetch docs, or modify indexes. Restart it after installing or updating a snapshot to load the new catalog. MCP clients discover sources with `list_docs`; each entry has a selector such as `nestjs@12`, its source and version, and the pinned revision. No CLI command is needed for discovery.

## MCP tools

| Tool          | Arguments                                                                                    | Behavior                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_docs`   | None                                                                                         | Lists each loaded selector, source, version, and revision. It does not expose filesystem paths.                                                                                                                                                   |
| `search_docs` | `query`, required non-empty `sources` (1–5 selectors), optional `limit` (1–10 total results) | Searches only the requested indexes and returns separate ranked groups per selector.                                                                                                                                                              |
| `fetch_docs`  | One `selector`, `documentId`, optional `sectionId` and `cursor`                              | Fetches bounded Markdown from that exact local index. The structured response includes up to 100 resolved internal links fully visible on this page, with target IDs that can be fetched offline. Use a search result's `chunkId` as `sectionId`. |

Use selectors returned by `list_docs` or the result groups from `search_docs`. Unknown selectors fail with an instruction to call `list_docs`; NekoSearch never falls back to searching the full catalog. The `limit` is a total result budget across all groups, so multi-source requests return at most 10 results. Filesystem paths are accepted only by the local CLI.

## Development

```sh
nvm use
npm ci
npm run build
npm test
```

The build compiles NekoSearch and its local snapshot builder. It does not fetch NestJS docs. The source-specific NestJS ingestion code is used only when the optional `add` or `update` command runs.

## License

[MIT](LICENSE)
