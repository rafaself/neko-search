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
npm install --global nekosearch
nekosearch --help
```

Installing the npm package does not download or build NestJS documentation. Use `nekosearch list` to see the sources available locally; a new catalog contains the bundled MCP protocol summary and no NestJS source.

## First-run setup

Run the interactive setup when you want to install curated docs and register this local server with an MCP client:

```sh
nekosearch setup
```

Setup asks which curated documentation snapshots you want, offers an optional Qwen3-Embedding-0.6B installation (~625 MB across all release assets), then checks for supported provider CLIs. Skipping keeps Semantic Search disabled and avoids downloading the model or loading the ML runtime. Choosing installation checks the optional runtime before downloading Qwen3, validates the model and existing snapshot vectors before enabling, and ingests selected new docs with embeddings. Grok Build is available when its CLI is installed and reports a safe user-level registration inventory. Matching NekoSearch registrations start checked; conflicts are shown as disabled choices. Uncheck a verified registration to remove it after review. The keyboard help at the bottom reflects the focused option (`Space: select` or `Space: unselect`) and includes `Backspace: go back`.

Before it changes anything, setup shows a final overview of the documentation, Semantic Search choice, and providers selected. Downloads, local indexing, and provider configuration begin only after you confirm. If model setup, docs download, or provider configuration fails, setup reports the failure and continues with remaining operations; Semantic Search is enabled only after model and snapshot validation succeeds. Provider registrations are added, inspected, and removed through the provider's official CLI. NekoSearch does not directly edit third-party JSON, JSONC, TOML, or other configuration files. Conflicting or unrecognized registrations remain untouched, and re-running setup leaves matching registrations unchanged. On a non-interactive terminal it exits before checking providers or downloading docs.

Package installation and upgrades never run setup automatically. Setup only downloads documentation when you explicitly select a curated source. Client registration is local and uses the absolute Node.js executable, the installed NekoSearch CLI path, and the `serve` argument. It does not start a shell, edit project settings, start a daemon, or enable an HTTP listener.

### MCP client support

NekoSearch currently supports provider management through official CLI commands only. The inspection command runs from a neutral temporary directory and reads registration metadata without starting MCP servers. An unfamiliar CLI output or unknown registration origin disables automatic setup.

| Provider       | Setup support                                                                  | Requirement and management path                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grok Build CLI | Automatic through `grok inspect --json`, `grok mcp add`, and `grok mcp remove` | Install the Grok Build CLI and make `grok` available on `PATH`. NekoSearch registers only in the user scope. [Official Grok MCP CLI docs](https://docs.x.ai/build/features/mcp-servers) |

A registration being written does not prove that a client connected or completed an MCP handshake. NekoSearch does not run provider health checks because those checks can start the MCP server.

Configure or remove the same verified user registration without the interactive setup:

```sh
nekosearch mcp configure grok-build
nekosearch mcp remove grok-build
```

The provider-specific command is `grok mcp add --scope user nekosearch -- <node> <nekosearch-cli> serve`. Removal uses `grok mcp remove --scope user nekosearch` only after `grok inspect --json` confirms that the named registration has the expected command, arguments, and user origin. A same-name registration from another scope, an unknown origin, or a different command is left unchanged.

## Build and install your documentation

Build a snapshot from a local Markdown or MDX directory, then install it into your catalog:

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
nekosearch add --from ./snapshots/my-api
nekosearch list
nekosearch serve
```

For a one-step offline install from a local docs directory, use:

```sh
nekosearch add --dir ./docs --id my-api@1
```

`add --dir` builds into a private temporary directory, validates the result, and installs it into your catalog. It refuses to replace an existing selector. `build` and `add --dir` scan supported Markdown and MDX files without compiling or executing MDX, and make no network requests.

`build` writes `corpus.json`, `index.sqlite`, and `manifest.json` to the output directory you choose; it does not install the snapshot. `add --from` validates and installs an existing portable snapshot directory. It also works with snapshots built by another tool, provided they contain the same three files and a supported manifest. The installed SQLite database is stored under the user catalog:

- Linux and macOS: `$XDG_DATA_HOME/nekosearch/snapshots/` or `~/.local/share/nekosearch/snapshots/` when `XDG_DATA_HOME` is unset.
- Windows: `%LOCALAPPDATA%\nekosearch\snapshots\`.

## Optional public GitHub source

Install Markdown or MDX from one directory of a public GitHub repository:

```sh
nekosearch add --github https://github.com/owner/repository --ref main --path docs --id my-api@1
```

This command accepts repository URLs on `https://github.com` only. It resolves the requested ref to a commit, lists that commit's Git tree, then downloads only regular `.md` and `.mdx` files inside `--path`. Symlinks and submodules are skipped; repository code is never executed and dependencies are never installed. Requests use bounded timeouts and responses are limited to 10,000 files, 4 MiB per file, and 64 MiB total. The snapshot records the normalized repository URL, requested ref, documentation directory, and resolved commit. GitHub installs are untracked and do not gain update behavior from provenance alone. This command requires network access; `serve` remains offline.

## Optional curated source: NestJS

NestJS 11 and 12 can be installed on demand:

```sh
nekosearch add nestjs@12
nekosearch update nestjs@12
nekosearch status
nekosearch status nestjs@12
nekosearch status nestjs@12 --check-upstream
nekosearch remove nestjs@12
```

`add` and `update` require network access to GitHub over HTTPS. NekoSearch resolves the curated official source ref to a concrete commit, downloads supported documentation files from that commit without Git, applies the NestJS-specific Markdown transformation, and builds and validates the SQLite snapshot locally. The resolved commit and ref are recorded in its manifest. Updates stay within the requested major and activate only after the replacement snapshot passes validation; a failed update leaves the active snapshot in place.

The current recipes use the official `nestjs/docs.nestjs.com` repository: the `11.0.0` tag for NestJS 11 and the `master` branch for NestJS 12. The repository also has a [`docs/v12-release` branch](https://github.com/nestjs/docs.nestjs.com/blob/docs/v12-release/content/migration.md) whose migration guide targets v12, but the most recent branch-specific commit returned by GitHub search is [from August 27](https://github.com/nestjs/docs.nestjs.com/commit/eeaec9ff11a02202382a21f5acb9a078bc8fccff), while `master` has [v12.5 documentation updates from November 13](https://github.com/nestjs/docs.nestjs.com/commit/1b25d9633a8afadd2c73e1a3e68b3a389420c775). The recipe stays on `master` for current docs and checks its migration guide before activating an update. This guarded moving ref can resolve to a revision that is not compatible with v12: `status --check-upstream` reports only that the ref resolves to a different commit, and `update` rejects an incompatible guide without replacing the active snapshot. If a configured ref cannot be resolved, installation fails instead of selecting another ref.

`nekosearch status` is offline by default. With no selector it shows the CLI version, catalog readability, and every available bundled or installed snapshot, including its active revision, origin, and tracking state. A selector shows only that snapshot and validates only its files. `status nestjs@12 --check-upstream` makes a read-only network check for that tracked recipe; it resolves the configured ref and compares commit IDs without downloading documentation or changing the catalog. Results distinguish `current`, `changed`, `untracked`, and `check failed`. A network or ref-resolution failure is reported as `check failed`, never as current. A snapshot pinned to an immutable commit, or installed with `add --from`, does not track future revisions.

## Optional local embedding model

Install the pinned Qwen3-Embedding-0.6B ONNX model only when you need local model inference:

```sh
nekosearch model install
nekosearch model status
nekosearch model remove
```

Installation downloads the `q8` model and its tokenizer/configuration from the immutable [v1.0.0 release](https://github.com/rafaself/nekosearch-models/releases/tag/qwen3-embedding-0.6b-v1.0.0). The installer validates the release-pinned manifest and every SHA-256 checksum, then activates the model only after verification. Interrupted transfers resume with HTTP range requests. `status` hashes the installed artifacts and reports model version, upstream revision, directory, integrity, and inference readiness.

The default model directory is under the same persistent application-data root as the documentation catalog:

- Linux and macOS: `$XDG_DATA_HOME/nekosearch/models/qwen3-embedding-0.6b/1.0.0` or `~/.local/share/nekosearch/models/qwen3-embedding-0.6b/1.0.0` when `XDG_DATA_HOME` is unset.
- Windows: `%LOCALAPPDATA%\nekosearch\models\qwen3-embedding-0.6b\1.0.0`.

Set `NEKOSEARCH_MODEL_DIR` or pass `--dir <model-dir>` to use an exact alternate model directory. Use the same override for `status` and `remove`; set `NEKOSEARCH_MODEL_DIR` when running embedding commands or `serve` with an alternate location. Removal requires the NekoSearch ownership marker and deletes only the release files it manages. Other files in that directory are preserved. Removal is blocked while Semantic Search is enabled; run `nekosearch embeddings disable` first. Once removed, inference is reported unavailable until the model is installed again.

The npm package does not download model weights or install the ML runtime for lexical-only users. Transformers.js is an optional peer dependency, pinned to `4.3.2`; it brings ONNX Runtime Node `1.30.0`. To enable local inference, install it in the application directory that launches NekoSearch:

```sh
npm install --save-exact @huggingface/transformers@4.3.2
```

Inference reads only the versioned local model directory, disables Transformers.js remote models, uses CPU execution, and does not require a network connection. The validated runtime is Linux x64 on Node.js `24.22.2`.

The local `EmbeddingGenerator` accepts document batches and individual queries. Queries are formatted as `Instruct: Given a query about software documentation, retrieve relevant documentation passages that answer the query\nQuery:<query>`; documents are passed without a prefix. The generator loads one shared CPU `q8` pipeline per model directory, processes one item at a time to cap memory use, selects each sequence's last attended token, and L2-normalizes the resulting 1024-dimensional vectors. Inputs are truncated at 8,192 tokens for the validated runtime.

To generate vectors for documentation already installed in the catalog, run `nekosearch embeddings build` or select one source with `nekosearch embeddings build nestjs@12`. This reads the saved canonical chunks and preserves the active FTS5 index; it does not fetch source files or parse Markdown again. `nekosearch embeddings status` reports Semantic Search configuration, runtime readiness, and embedding coverage. A complete compatible build is idempotent, and each snapshot is promoted only after validation.

Ingestion reads `nekosearch.yaml` from the current directory, or the path in `NEKOSEARCH_CONFIG`:

```yaml
search:
  semantic:
    enabled: false
```

Semantic Search defaults to disabled, including when the file is absent. In that mode, serving and snapshot builds stay lexical and do not inspect the model or load its runtime. Run `nekosearch embeddings enable` to verify the installed model, runtime, and installed snapshots before setting `enabled: true`; if vectors are missing, the command tells you to run `nekosearch embeddings build`. With no installed documentation sources, enabling is allowed so later ingestion generates vectors automatically. `nekosearch embeddings disable` turns off hybrid retrieval while preserving the model and generated vectors. Model removal is blocked while Semantic Search is enabled; disable it first. New snapshots built while enabled also receive vectors. Serving embeds each query once and fuses the lexical and semantic rankings within each selected snapshot using reciprocal rank fusion. Every source selected for a hybrid request must have compatible vectors; a selected source without vectors returns an actionable error instead of falling back to lexical search. The bundled `mcp@2025-11-25` snapshot is lexical-only, so omit it from hybrid `sources` or disable Semantic Search. Ingestion and serving never download the model or use remote inference.

Incremental builds reuse vectors only when the model revision, artifact checksum, embedding dimensions, data type, pooling, normalization, query instruction, pipeline version, chunk ID, and chunk content all match. New or changed chunks are embedded locally; changed embedding metadata requires a full regeneration. Programmatic snapshot builders can still accept a complete `embeddingSet` with the exported `LOCAL_QWEN3_EMBEDDING_SPACE` metadata. Hybrid search uses Top 50 candidates from each retriever, equal-weight RRF with `k = 60`, and chunk-ID tie-breaking; the public result limit and per-source grouping remain unchanged.

To validate an installed model without network access, build NekoSearch and run `NEKOSEARCH_MODEL_DIR=<model-dir> npm run validate:qwen3`. The validation script blocks `fetch`, checks vector dimensions and normalization, and verifies retrieval ranking on two query/document pairs.

The dedicated real-inference Jest test is skipped in regular CI. Run it with `NEKOSEARCH_RUN_QWEN3_INTEGRATION=1` on a supported Node.js host with the optional inference runtime and a verified local model already installed; it never downloads model files. To compare BM25 and Hybrid Search, install NestJS 11 and 12 snapshots, build their embeddings, then run `npm run search:evaluate`. The evaluator blocks network access and prints Recall@5, MRR@10, nDCG@10, p50/p95 latency, cold model initialization, sampled embedding throughput, RSS measurements, exact-symbol results, and regressions. Set `NEKOSEARCH_EVALUATION_CATALOG_ROOT` to select a catalog, `NEKOSEARCH_EVAL_OUTPUT` to save JSON, and `NEKOSEARCH_EVAL_EMBEDDING_SAMPLE_SIZE` to change the throughput sample size.

## Network access and serving

| Command                                                     | Network access  | What it does                                                                       |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `nekosearch build ...`                                      | No              | Builds a snapshot from local files at the chosen output path.                      |
| `nekosearch add --dir ... --id ...`                         | No              | Builds, validates, and installs a local Markdown/MDX directory.                    |
| `nekosearch add --from ...`                                 | No              | Validates and installs a local snapshot.                                           |
| `nekosearch add --github ... --ref ... --path ... --id ...` | Yes             | Fetches supported Markdown/MDX files from a public GitHub repo at a pinned commit. |
| `nekosearch list`                                           | No              | Lists bundled and installed snapshots.                                             |
| `nekosearch status [<source@version>]`                      | No              | Shows catalog and snapshot state without contacting upstream sources.              |
| `nekosearch remove <source@version>`                        | No              | Removes an installed snapshot from the catalog and retires its active files.       |
| `nekosearch setup`                                          | Conditional     | Local prompts and client checks are offline; only selected curated docs use HTTPS. |
| `nekosearch status [<source@version>] --check-upstream`     | Yes             | Resolves selected tracked refs only; does not download docs or write the catalog.  |
| `nekosearch add nestjs@11` / `nestjs@12`                    | Yes             | Fetches the selected curated source over HTTPS and builds it locally.              |
| `nekosearch update nestjs@11` / `nestjs@12`                 | Yes             | Resolves and builds the requested major's latest curated commit.                   |
| `nekosearch serve`                                          | No              | Serves search and fetch tools over stdio using read-only SQLite connections.       |
| `nekosearch mcp configure grok-build`                       | No              | Adds the verified user registration through the Grok Build CLI.                    |
| `nekosearch mcp remove grok-build`                          | No              | Removes only the verified NekoSearch user registration through the Grok Build CLI. |
| `nekosearch model install` / `model remove`                 | Yes for install | Installs or removes only NekoSearch-managed model release assets.                  |
| `nekosearch model status`                                   | No              | Verifies model checksums and reports inference readiness.                          |

`remove` is offline and only removes installed snapshots; bundled snapshots cannot be removed. It removes the selector from the catalog and retires its active snapshot files. A running `serve` process keeps using the SQLite indexes it opened at startup; restart it to load catalog changes. If the filesystem cannot retire files still in use, the command reports a cleanup warning.

`serve` does not open a network listener, fetch docs, or modify indexes. Restart it after installing, updating, or removing a snapshot to load the new catalog. MCP clients discover sources with `list_docs`; each entry has a selector such as `nestjs@12`, its source and version, and the pinned revision. No CLI command is needed for discovery.

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
