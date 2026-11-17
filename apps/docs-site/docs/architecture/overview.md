---
title: Architecture Overview
description: Understand the boundaries between the NekoSearch CLI, documentation indexer, reusable engine, catalog, retrieval, and MCP transport.
---

# Architecture Overview

NekoSearch separates preparing documentation from serving it. The CLI coordinates explicit operations; the MCP server consumes validated snapshots through read-only retrieval.

```text
Preparation
  Local files / public GitHub / curated integration
    → documentation indexer
    → documentation engine: parse, normalize, resolve links, index
    → portable snapshot
    → validated user catalog installation

Serving
  Catalog + bundled reference
    → read-only retrieval per source
    → MCP stdio tools
    → coding client
```

## Responsibility boundaries

| Boundary                                               | Responsibility                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| CLI (`src/apps/nekosearch`)                            | Public command parsing, setup, installation, status, and server launch                                       |
| Documentation indexer (`apps/docs-indexer`)            | Build orchestration, configuration, incremental builds, and source-specific integrations                     |
| Documentation engine (`packages/documentation-engine`) | Shared schemas, discovery, static parsing, normalization, link resolution, indexing, and retrieval contracts |
| Snapshot catalog                                       | Bundled/installed source discovery, validation, safe activation/removal, and curated tracking associations   |
| Retrieval                                              | Query validation, ranked source-local search, section fetches, pagination, and references                    |
| MCP transport                                          | Public tool schemas, source selection, structured/text presentation, and stdio lifecycle                     |
| Documentation website (`apps/docs-site`)               | Static product documentation, with its own build and browser-local search                                    |

The documentation website is a private npm workspace. It is not loaded by the production CLI, and its content is not automatically ingested into the external documentation catalog.

## Build-time integrations

Generic local and GitHub ingestion use the shared Markdown/MDX pipeline. The optional NestJS integration supplies curated version recipes and a framework-specific transformation. Adding NestJS is not a prerequisite for serving another documentation source.

The root build compiles the engine, indexer, and CLI, then copies the builder runtime required by public local/curated commands. It does not download optional documentation or build the website.

## Validated snapshots as a boundary

A snapshot consists of a corpus, SQLite index, and manifest. Builders produce these files together. The installer validates them before promoting the snapshot into the catalog. A catalog lock and identity checks coordinate competing mutations; callers must handle conflicts rather than assuming their previously read state is still current.

Curated replacement validates the candidate before changing the active entry. Imported snapshots carry provenance without inheriting a curated recipe's update authority.

## Read-only sessions

The server reads the catalog once, creates a retrieval service for each source, and opens each SQLite database read-only. It registers `list_docs`, `search_docs`, and `fetch_docs`, then connects stdio.

Tool requests cannot install sources, provide arbitrary filesystem paths, or make the server fetch linked pages. Client-side catalog changes become visible after a server restart. This session model also explains why a running process can continue reading a snapshot that has been removed from the active catalog.

Continue with [Documentation Engine](./documentation-engine.md) and [Retrieval](./retrieval.md) for the contributor-facing data flow.
