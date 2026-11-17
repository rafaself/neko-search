---
title: Installation
description: Install NekoSearch and understand its Node.js requirements, bundled reference, and local runtime.
---

# Installation

NekoSearch is a local, read-only MCP server for documentation snapshots. It turns Markdown and MDX into searchable indexes, then gives AI coding agents structured access to the sources you select.

Install curated documentation, build from your own files, or ingest a directory from a public GitHub repository. The MCP server searches installed snapshots without fetching documentation while it runs.

## Requirements

- **Node.js:** `^24.15.0 || >=26.0.0`, matching the package's engine declaration. Node 25 is outside this supported range.
- **npm:** for installing the CLI.
- **An MCP client with stdio support:** for agent integration. See [Client Configuration](../mcp/client-configuration.md).
- **An interactive terminal:** when using `nekosearch setup`.

SQLite support comes from Node.js. You do not need a separate database server, a Git installation for GitHub ingestion, or a search API key.

## Install the CLI

```sh
npm install --global nekosearch
nekosearch --help
```

The executable is named `nekosearch`. Installation and package upgrades do not run interactive setup or download optional documentation.

## What is included?

A small MCP protocol summary is bundled as `mcp@2025-11-25`. This is reference content that NekoSearch can search, separate from these product docs and from the MCP server implementation.

NestJS is an optional curated source. No NestJS snapshot is bundled or required.

```sh
nekosearch list
```

This lists bundled and installed snapshots. A new catalog has the bundled MCP reference and no NestJS source.

## Choose your next step

- [Quick Start](./quick-start.md): connect an agent and make your first search.
- [Interactive Setup](./setup.md): choose optional curated documentation and client registrations.
- [Custom Documentation](../guides/custom-documentation.md): install a directory from your own project.

::: tip Offline after installation
Local builds, local snapshot installation, and MCP serving work without network access. Curated installation, public GitHub ingestion, and explicit upstream checks require HTTPS access to GitHub.
:::
