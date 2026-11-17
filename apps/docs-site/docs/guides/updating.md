---
title: Updating & Removing
description: Inspect source revisions, update curated documentation, replace custom snapshots, and remove installed sources.
---

# Updating & Removing

Installed snapshots are fixed local copies. They change only when you explicitly install, update, or remove them. The MCP server never refreshes documentation in the background.

## Inspect local state

```sh
nekosearch status
nekosearch status nestjs@12
```

Without a selector, `status` reports the CLI version, catalog readability, and each available source's revision, origin, tracking state, and upstream-check status. With a selector, it reads only that snapshot. Both forms are offline by default.

## Check a tracked source

```sh
nekosearch status nestjs@12 --check-upstream
```

An explicit upstream check resolves the tracked recipe's ref over HTTPS and compares revisions. It does not download documentation, rebuild an index, or change the catalog.

| Result         | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `current`      | The tracked ref resolves to the installed revision              |
| `changed`      | The ref resolves to a different commit                          |
| `untracked`    | The source has no applicable curated tracking association       |
| `check failed` | The check failed; it is not evidence that the source is current |

Bundled sources are not applicable to upstream tracking. Imported GitHub snapshots are untracked even when their manifest contains a branch name. Immutable commit refs are pinned when applicable to the tracking logic.

::: info A changed ref is not a validated update
The upstream check compares commit IDs only. A subsequent build can still fail. For example, a moving curated ref can contain a migration guide that fails the requested major's compatibility check.
:::

## Update curated documentation

```sh
nekosearch update nestjs@12
```

The source must already be installed and associated with the matching curated recipe. Only NestJS 11 and 12 are supported by this command. Updates stay within the requested major, resolve the recipe's ref, build locally, validate the replacement, and activate it only after success.

A failed update keeps the previously active snapshot. If the revision and snapshot are already current, the CLI reports that no replacement is needed. Network failures and unresolved refs do not silently select a fallback source.

## Custom documentation

There is no general `update --dir`, `update --github`, or `update --from` command. Rebuild or re-ingest explicitly.

To keep the existing installed copy while preparing a replacement, use a new selector:

```sh
nekosearch add --dir ./docs --id my-api@2
nekosearch status my-api@2
```

Then restart the server and select `my-api@2` in your agent's requests. Remove the older version when you no longer need it.

To reuse a selector, prepare and validate a portable build first, then remove and reinstall:

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
nekosearch remove my-api@1
nekosearch add --from ./snapshots/my-api
```

Removal and reinstallation are separate operations. If installation fails after removal, that selector is absent until a valid snapshot is installed. A separate version avoids that gap.

For public GitHub sources, repeat `add --github` with a new selector or remove the old selector first. Git provenance alone does not authorize curated update behavior.

## Remove an installed snapshot

```sh
nekosearch remove my-api@1
```

Removal is offline. It removes the installed catalog entry and retires its active snapshot files. Bundled sources cannot be removed. If files cannot be retired or cleaned up, the command can report a cleanup warning even after the catalog entry has been removed.

## Reload the MCP server

Restart NekoSearch through your client after every catalog change. An existing server session keeps its startup indexes, including a snapshot removed from the catalog during that session.

To upgrade the CLI itself, use `npm install --global nekosearch`. This is separate from updating curated snapshots and does not run setup automatically.
