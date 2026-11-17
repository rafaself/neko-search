---
title: Custom Documentation
description: Build, install, and search a local Markdown or MDX documentation project with internal references.
---

# Custom Documentation

Give your agent a local reference for your API, service, or engineering conventions. You can build documentation entirely offline from Markdown and MDX.

## Prepare the source directory

For example, use this documentation tree in your own project:

```text
docs/
  index.md
  authentication.md
```

::: code-group

```md [docs/index.md]
# My API

My API uses bearer tokens to authenticate requests.

See [Authentication](./authentication.md#bearer-tokens).
```

```md [docs/authentication.md]
# Authentication

## Bearer tokens

Send the token in the Authorization header.

Use a development token when testing locally.
```

:::

These files are an example of your own documentation, separate from the NekoSearch website and bundled protocol reference. Use clear headings and relative links so the parser can retain useful sections and resolve internal references.

## Install directly

```sh
nekosearch add --dir ./docs --id my-api@1
nekosearch status my-api@1
```

Use a source ID beginning with a letter or number and containing letters, numbers, `.`, `_`, or `-` (up to 128 characters for local builds). The version is a nonblank string of at most 64 characters without control characters. A simple selector such as `my-api@1` works well.

The command refuses an existing selector. Nothing is installed if parsing, building, or validation fails.

## Build a portable snapshot

If you want to inspect, copy, or distribute the snapshot before installing it:

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
nekosearch add --from ./snapshots/my-api
```

Choose either direct installation or this two-step route for a new selector. Running both without removing the first installation produces a duplicate-selector error.

Keep all three [snapshot files](./snapshots.md#build-output) together. A copied snapshot remains an imported source and does not gain curated update tracking.

::: warning Snapshot contents
Snapshots contain documentation text and source provenance, including local paths for local builds. Review the files before sharing a snapshot containing internal documentation.
:::

## Search your documentation

Restart the MCP server through your client. Ask the agent to discover the source, then use:

```json
{
  "name": "search_docs",
  "arguments": {
    "query": "bearer tokens",
    "sources": ["my-api@1"],
    "limit": 3
  }
}
```

Fetch a hit with its returned IDs. Internal references in `fetch_docs` output supply target `documentId` and optional `sectionId` values, so your agent can follow the authentication link without fetching a website.

Resolved references stay within the same snapshot. External or unresolved links remain in the Markdown. The bundled legacy MCP reference predates resolved-link metadata; newly built snapshots support it.

## Keep source content static

The parser retains Markdown and supported static MDX content. It does not render your site's Vue or React components, run imports or JavaScript expressions, or fetch linked pages. Put essential API explanations in static prose and code blocks. Review build diagnostics for content that could not be represented.

For discovery limits and supported ingestion formats, see [Documentation Sources](./documentation-sources.md). For refreshing your installed copy, see [Updating & Removing](./updating.md#custom-documentation).
