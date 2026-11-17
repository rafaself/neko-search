---
title: MCP Overview
description: How AI coding clients launch NekoSearch over stdio and use its read-only documentation tools.
---

# MCP Overview

NekoSearch implements an MCP server using **stdio transport**. A client launches a local child process, sends protocol messages to stdin, and reads responses from stdout.

```text
MCP client
  └─ Node.js → NekoSearch CLI → serve
       ├─ list_docs
       ├─ search_docs
       └─ fetch_docs
            └─ validated local SQLite indexes (read-only)
```

There is no HTTP endpoint, SSE listener, remote account, or retrieval API key. Network access used to install documentation is separate from serving the installed snapshots.

## Launch the server

The CLI entry point is:

```sh
nekosearch serve
```

Use [Interactive Setup](../getting-started/setup.md) to register this command with supported clients. Setup uses an absolute Node executable and CLI path so client startup does not depend on the shell finding a global binary.

The process loads and validates the catalog before connecting its MCP transport. Stdout is protocol-only; readiness messages, failures, and optional debug timings go to stderr. The process shuts down when its input closes or a termination signal is handled.

## Retrieval workflow

1. **Discover:** call `list_docs` for the selectors loaded in this session.
2. **Search:** call `search_docs` with an explicit list of 1–5 selectors.
3. **Fetch:** pass one result group's selector and a hit's `documentId` to `fetch_docs`.
4. **Focus:** use a search hit's `chunkId` as `sectionId` to fetch its section.
5. **Continue or follow:** use `nextCursor` to continue a truncated result, or a returned internal reference's target IDs to fetch related content.

Tool responses contain both human-readable text in `content` and machine-readable `structuredContent`. Search output is grouped by selector and includes the pinned revision. Fetch output includes section Markdown, canonical URLs, and the document's source revision.

## Explicit source boundaries

The server does not infer a default source or broaden an invalid request. Unknown selectors fail with an instruction to call `list_docs`; duplicate selectors are invalid. A fetch targets exactly one source.

The shared search limit applies across all selected sources. Each source keeps its own ranking; scores are not merged into a single global relevance list.

All three tools advertise read-only, nondestructive, idempotent, closed-world annotations. These describe local retrieval behavior; they do not cause linked external pages to be downloaded.

## Session lifecycle

Sources are loaded once at startup. Installing, updating, or removing a snapshot does not change an existing server session. Restart NekoSearch through the client and rediscover sources after catalog changes.

See [Tool Reference](./tools.md) for the exact inputs and outputs, and [Client Configuration](./client-configuration.md) for adapter details.
