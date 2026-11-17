---
title: Introduction
description: Learn how NekoSearch gives AI coding agents structured access to local documentation snapshots through MCP.
---

# Introduction

NekoSearch is a local, read-only MCP server for searching documentation snapshots. It gives AI coding agents structured access to the documentation you choose, with explicit source selectors, section-level retrieval, and source revisions attached to the results.

Build a snapshot from your own Markdown or MDX, install a curated source, or ingest a documentation directory from a public GitHub repository. Your coding client launches NekoSearch over stdio and searches the installed snapshots locally.

## Why NekoSearch?

An agent needs documentation for the source and version you are working with. NekoSearch makes that choice explicit: discover the available sources, search selected snapshots, and fetch the relevant sections.

- **MCP-native retrieval:** three focused tools to discover, search, and fetch documentation.
- **Your documentation:** ingest local Markdown and MDX, public GitHub directories, or portable snapshots.
- **Curated sources:** install optional NestJS 11 or 12 documentation from the official repository.
- **Local snapshots:** serve installed documentation without fetching pages or opening a network listener.
- **Source-scoped search:** search up to five exact selectors together while keeping results grouped by source.
- **Internal references:** follow resolved document and section links within a snapshot.
- **Coding client integration:** configure supported clients such as Codex, Claude Code, and Cursor through interactive setup.

A small MCP protocol summary is bundled with the CLI. NestJS is optional; no NestJS snapshot is bundled or required.

## How it works

Documentation moves through a preparation step before your agent retrieves it:

```text
Documentation sources
  → Ingestion and processing
  → Documentation snapshots
  → Retrieval engine
  → MCP server
  → AI coding agents
```

Each snapshot contains a normalized corpus, a SQLite search index, and a manifest describing its identity and provenance. The server opens validated indexes read-only when it starts.

The agent calls `list_docs` to discover available sources, `search_docs` to search exact selectors, and `fetch_docs` to read a document or section. Results include canonical URLs and source revisions. See the [MCP overview](./mcp/overview.md) for the complete workflow.

::: tip Explicit sources
NekoSearch searches only the sources requested by the client. An unknown selector is an error; it never silently expands a request to the entire catalog.
:::

## Get started

Install the CLI with a [supported Node.js version](./getting-started/installation.md#requirements):

```sh
npm install --global nekosearch
nekosearch setup
nekosearch list
```

Interactive setup lets you select optional curated documentation and review client registrations before confirming changes. Your client starts the MCP server when it connects.

Follow the [Quick Start](./getting-started/quick-start.md) to make your first search using the bundled reference, or read [Installation](./getting-started/installation.md) for requirements and installation details.

## Bring your own documentation

From a project containing Markdown or MDX in a `docs` directory:

```sh
nekosearch add --dir ./docs --id my-api@1
```

Restart the client's NekoSearch process after installation, then ask the agent to discover and search `my-api@1`. See [Custom Documentation](./guides/custom-documentation.md) for a complete example with internal references.

For other ingestion options, read [Documentation Sources](./guides/documentation-sources.md). To understand storage, provenance, and updates, continue with [Snapshots](./guides/snapshots.md).

## Explore the documentation

- [Getting Started](./getting-started/installation.md): installation, your first search, and interactive setup.
- [Guides](./guides/documentation-sources.md): documentation sources, snapshots, custom documentation, and updates.
- [CLI Reference](./cli/commands.md): supported commands, arguments, options, and errors.
- [MCP Tool Reference](./mcp/tools.md): tool inputs, structured output, pagination, and references.
- [Architecture](./architecture/overview.md): the boundaries between the CLI, indexer, engine, catalog, and transport.
- [Development](./development/development-setup.md): contributor setup and validation.
