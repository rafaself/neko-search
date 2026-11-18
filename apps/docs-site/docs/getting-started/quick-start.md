---
title: Quick Start
description: Connect an AI coding agent, discover a documentation source, and make your first MCP search and fetch.
---

# Quick Start

This walkthrough uses the curated `nestjs@12` snapshot for its first search.

## 1. Install NekoSearch and start setup {#install-nekosearch}

```sh
npm install --global nekosearch && nekosearch setup
```

Use a [supported Node.js version](./installation.md#requirements). Once npm finishes, setup opens in the same terminal. Select `nestjs@12` as the source for this walkthrough. Installing it requires HTTPS access to GitHub. The catalog includes the bundled `mcp@2025-11-25` reference.

## 2. Connect your agent {#connect-your-agent}

In the setup wizard, select Codex, Claude Code, Cursor, or Grok Build when detected. Review and confirm the proposed changes. Setup installs the selected snapshot and registers NekoSearch with the selected client. If you already have NekoSearch, run `nekosearch setup` to open the wizard again. Confirm the snapshot is available with `nekosearch list`.

Restart or reconnect your client as needed so it loads its MCP configuration. Your client launches the server; you do not need to keep a separate `nekosearch serve` terminal running.

To configure or remove Codex directly from the CLI:

```sh
nekosearch mcp configure codex
nekosearch mcp remove codex
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
- **A client is missing from setup:** check that its executable is on `PATH`. See detection rules and manual stdio configuration in the [client configuration reference](../mcp/client-configuration.md).
- **Unknown source selector:** call `list_docs` in the current session and use an exact returned selector.
- **New source absent:** restart the MCP server through your client.
- **Catalog error:** run `nekosearch status` to inspect local snapshot state.
