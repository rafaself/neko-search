---
title: Snapshots
description: Understand portable snapshots, local storage, validation, source provenance, and content revisions.
---

# Snapshots

A snapshot is a fixed, searchable representation of one documentation source and version. It carries normalized documentation, a SQLite search index, and a manifest describing its identity and provenance.

## Build output

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
```

| File            | Purpose                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `corpus.json`   | Normalized documents, chunks, source metadata, and resolved references                |
| `index.sqlite`  | Searchable documentation and retrieval data                                           |
| `manifest.json` | Documentation identity, source revision, hashes, counts, and format/pipeline metadata |

`build` writes these files to your chosen output directory. It does not install them into the catalog. Repeated builds are incremental by default: compatible, unchanged documents can be reused. `--clean` builds without reusing a previous output.

Output is staged and validated before promotion. The builder rejects overlapping local input/output directories. Keep snapshots outside the documentation tree.

## Lexical and semantic snapshots

NekoSearch snapshot builders always build the FTS5/BM25 index. Semantic vectors are optional and disabled by default. Add this file to the current working directory to configure snapshot ingestion, or set `NEKOSEARCH_CONFIG` to a different YAML file:

```yaml
search:
  semantic:
    enabled: false
```

With `enabled: false` or no config file, ingestion does not check for or load Qwen3. With `enabled: true`, first install the pinned model with `nekosearch model install` and install the optional Transformers.js runtime. Build, `add --dir`, `add --github`, curated installs and updates, and package snapshot builds then generate vectors locally. They never install the model or call remote inference implicitly.

Incremental builds reuse vectors for unchanged chunks only when the complete model/pipeline metadata and the chunk ID and content match. Other chunks are regenerated. The completed vector table and manifest are validated before the snapshot is promoted or installed.

## Install a snapshot

```sh
nekosearch add --from ./snapshots/my-api
nekosearch list
```

Installation checks the supported manifest and corpus schemas, hashes, source/version consistency, counts, and SQLite index integrity. Files must be real files, not symlinks. A successful installation copies the snapshot into NekoSearch's catalog; it does not keep reading the original output directory.

`add --dir` combines local build, validation, and installation. `add --github` and curated `add` commands also install only after building and validating their snapshots.

## Local storage

| Platform        | Catalog root                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Linux and macOS | `$XDG_DATA_HOME/nekosearch`, or `~/.local/share/nekosearch` when unset or blank                          |
| Windows         | `%LOCALAPPDATA%\nekosearch`, falling back to the home directory's `nekosearch` child when unset or blank |

The root contains `catalog.json` and a `snapshots/` directory. Installed snapshot directories use generated storage keys; use CLI selectors instead of constructing those paths yourself. Bundled documentation is read from the installed package's data directory and is listed alongside installed sources.

Inspect the catalog without network access:

```sh
nekosearch status
nekosearch status my-api@1
```

The selector-specific form reads and validates only the selected snapshot. The overview reports catalog readability and available sources.

## Identity, revision, and provenance

- **Selector:** `source@version`, the explicit address used by CLI and MCP operations.
- **Revision:** identifies the indexed source state. Local discovery hashes the ordered relative paths and file contents; GitHub ingestion records the resolved commit.
- **Provenance:** describes where a source came from, such as a local root or a Git repository/ref and optional docs directory.
- **Tracking:** a separate catalog association with a curated recipe. Git provenance alone does not establish tracking.

Local builds use deterministic `https://docs.example/<scope>/…` canonical routes derived from their identity and paths. This synthetic domain is an identifier, not a hosted documentation website. Public GitHub ingestion derives routes from the pinned repository revision; curated sources use their recipe's canonical routes.

Search hits include a source revision and canonical URL. Fetch responses return the document's revision as well as the source metadata. Do not interpret a version label as proof that the source is current upstream.

## Serving and replacement

The server opens validated SQLite indexes read-only at startup. It never rebuilds them during retrieval and does not watch the catalog for changes.

After any installation, update, or removal, **restart the client's NekoSearch process** to load the new catalog. A running session continues using the indexes it already opened.

See [Updating & Removing](./updating.md) for curated updates and replacing imported snapshots.
