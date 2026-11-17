---
title: Quick Start
description: Connect an AI coding agent, discover a documentation source, and make your first MCP search and fetch.
---

# Quick Start

This walkthrough uses the curated `nestjs@12` snapshot for its first search.

## 1. Install NekoSearch {#install-nekosearch}

```sh
npm install --global nekosearch
nekosearch add nestjs@12
nekosearch list
```

Use a [supported Node.js version](./installation.md#requirements). Adding the NestJS snapshot requires HTTPS access to GitHub. The catalog also includes the bundled `mcp@2025-11-25` reference.

## 2. Connect your agent {#connect-your-agent}

```sh
nekosearch setup
```

Select a detected MCP client, then review and confirm the proposed changes. Setup recognizes the installed `nestjs@12` snapshot and configures the client to launch the installed Node executable with the NekoSearch CLI and its `serve` argument.

Restart or reconnect your client as needed so it loads its MCP configuration. Your client launches the server; you do not need to keep a separate `nekosearch serve` terminal running.

For Codex, there is also a dedicated command:

```sh
nekosearch mcp configure codex
```

See [Client Configuration](../mcp/client-configuration.md) if a client is not detected or needs manual configuration.

## 3. Discover documentation {#discover-documentation}

Ask your agent:

> Use NekoSearch's list_docs tool to show the documentation available in this session.

At the MCP tool boundary, the request is:

```json
{
  "name": "list_docs",
  "arguments": {}
}
```

Use the exact `selector` from the response in subsequent calls. Selectors identify sources and versions; revisions identify the contents of those snapshots.

## 4. Search, then fetch {#search-then-fetch}

Ask your agent:

> Search nestjs@12 for dependency injection providers. Fetch a matching section and cite its returned source URL and revision.

The search tool arguments are:

```json
{
  "name": "search_docs",
  "arguments": {
    "query": "dependency injection providers",
    "sources": ["nestjs@12"],
    "limit": 3
  }
}
```

For the next `fetch_docs` call, pass the result group's `selector`, a hit's `documentId`, and optionally its `chunkId` as `sectionId`. See the [Tool Reference](../mcp/tools.md) for complete examples and response fields.

::: info Tool calls, not shell commands
`list_docs`, `search_docs`, and `fetch_docs` are MCP tools invoked by the client. They are not NekoSearch CLI subcommands.
:::

## 5. Add your own documentation {#add-your-own-documentation}

Install a local Markdown or MDX directory under its own source selector:

```sh
nekosearch add --dir ./docs --id my-api@1
nekosearch list
```

Restart the client's NekoSearch server after installation, then call `list_docs` again. A running server retains the indexes it opened at startup. See [Documentation Sources](../guides/documentation-sources.md) for GitHub and snapshot installation options.

## If something is missing

- **CLI not found:** check that your npm global executable directory is on `PATH`.
- **No client in setup:** use the [client configuration reference](../mcp/client-configuration.md); setup only offers eligible detected clients.
- **Unknown source selector:** call `list_docs` in the current session and use an exact returned selector.
- **New source absent:** restart the MCP server through your client.
- **Catalog error:** run `nekosearch status` to inspect local snapshot state.
