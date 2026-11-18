---
title: Installation
description: Install NekoSearch and understand its Node.js requirements, bundled reference, and local runtime.
---

# Installation

NekoSearch is a local, read-only MCP server for documentation snapshots. It turns Markdown and MDX into searchable indexes, then gives AI coding agents structured access to the sources you select.

Install curated documentation, build from your own files, or ingest a directory from a public GitHub repository. The MCP server searches installed snapshots without fetching documentation while it runs.

## Requirements

- **Node.js:** `>=24.15.0`, including Node 25. Node 26 LTS is recommended for new installations.
- **npm:** for installing the CLI.
- **An MCP client with stdio support:** for agent integration. See [Client Configuration](../mcp/client-configuration.md).
- **An interactive terminal:** when using `nekosearch setup`.

Lexical search needs no model or ML runtime. Optional Qwen3 inference is available on Linux x64 with the same Node.js minimum. Setup or `nekosearch model install` installs the optional Transformers.js `4.3.2` runtime and downloads about 625 MB of model release assets. See [Local Embeddings and Hybrid Search](../guides/hybrid-search.md) for the full workflow and measured resource notes.

SQLite support comes from Node.js. You do not need a separate database server, a Git installation for GitHub ingestion, or a search API key.

## Install NekoSearch

```sh
npm install --global nekosearch
nekosearch --help
```

The executable is named `nekosearch`. Installation and package upgrades do not run interactive setup or download optional documentation.

::: tip Ask your agent to configure NekoSearch
Paste this prompt into your AI coding agent:

```text
Install NekoSearch globally with npm if it is not already installed, then run `nekosearch setup` in an interactive terminal. Help me choose optional documentation and an MCP client. Before setup applies any changes, summarize the selections and wait for my confirmation. If my client is not available in setup, stop and show me the relevant NekoSearch client configuration instructions. When setup finishes, explain how to reconnect my client and make a first search.
```

:::

## What is included?

A small MCP protocol summary is bundled as `mcp@2025-11-25`. This is reference content that NekoSearch can search, separate from these product docs and from the MCP server implementation.

NestJS is an optional curated source. No NestJS snapshot is bundled or required.

```sh
nekosearch list
```

This lists bundled and installed snapshots. A new catalog has the bundled MCP reference and no NestJS source.

## Choose your next step

- [Quick Start](./quick-start.md): connect an agent and make your first search.
- [Interactive Setup](./setup.md): choose optional curated documentation and configure detected MCP providers.
- [Local Embeddings and Hybrid Search](../guides/hybrid-search.md): install Qwen3 later, build vectors, and enable hybrid retrieval.
- [Custom Documentation](../guides/custom-documentation.md): install a directory from your own project.

::: tip Offline after installation
Local builds, local snapshot installation, and MCP serving work without network access. Curated installation, public GitHub ingestion, and explicit upstream checks require HTTPS access to GitHub.
:::
