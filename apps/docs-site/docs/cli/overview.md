---
title: CLI Overview
description: Understand NekoSearch's command families, local catalog, network access, and MCP server lifecycle.
---

# CLI Overview

The `nekosearch` executable prepares your documentation catalog and starts its MCP server. Snapshot management and client configuration are explicit commands; serving is local and read-only.

```sh
nekosearch --help
```

## Command families

| Task                                         | Commands                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interactive onboarding and client selection  | `setup`                                                                            |
| Build without installing                     | `build`                                                                            |
| Install documentation                        | `add --dir`, `add --github`, `add --from`, `add nestjs@11`, `add nestjs@12`        |
| Inspect the catalog                          | `list`, `status`                                                                   |
| Manage documentation in a browser            | `ui`                                                                               |
| Manage the optional local model              | `model install`, `model status`, `model remove`                                    |
| Manage Semantic Search and vectors           | `embeddings build`, `embeddings status`, `embeddings enable`, `embeddings disable` |
| Refresh curated documentation                | `update nestjs@11`, `update nestjs@12`                                             |
| Remove an installed snapshot                 | `remove`                                                                           |
| Configure or remove an MCP user registration | `mcp configure <provider>`, `mcp remove <provider>`                                |
| Start the MCP stdio process                  | `serve`                                                                            |

There are no CLI `search` or `fetch` subcommands. Agents use the [MCP tools](../mcp/tools.md) to retrieve documentation.

## Source selectors

Commands address sources using `source@version`, for example `nestjs@12` or `my-api@1`. Use `list` to inspect installed selectors. MCP clients discover the selectors loaded into their session with `list_docs`.

Adding an existing selector fails rather than overwriting it. Only the curated NestJS integration has a public `update` command. See [Updating & Removing](../guides/updating.md) for custom replacements.

## Network access

| Command                                                                  | Uses network                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `build`, `list`, `remove`, `add --dir`, `add --from`                     | No                                                              |
| `model status`, `model remove`, `embeddings build/status/enable/disable` | No                                                              |
| `model install`                                                          | Yes, downloads the pinned npm runtime and GitHub Release assets |
| `status`                                                                 | No, unless `--check-upstream` explicitly requests checks        |
| `serve`, `mcp configure <provider>`, `mcp remove <provider>`             | No NekoSearch documentation download                            |
| `setup`                                                                  | Only for selected docs and model installation after review      |
| `add --github`, curated `add` and `update`                               | Yes, HTTPS to GitHub                                            |
| `ui`                                                                     | Only for curated installs, updates, and upstream checks         |

Your MCP client starts `serve` as a child process and communicates with it over stdin/stdout. Logs go to stderr. Model inference and search use the installed local model and snapshots. The `ui` command starts its own local HTTP dashboard for snapshot management.

## Exit and output behavior

Successful commands generally exit `0`. Operational failures exit `1`. Unknown command forms and invalid `status` or GitHub-add arguments exit `2`; setup also exits `2` in a non-interactive terminal. Setup cancellation exits `130`.

`list` and `status` write readable state to stdout. `build` writes its summary and diagnostics to stderr. `serve` reserves stdout for MCP protocol traffic. There is no general-purpose CLI `--json` output option.

Use the [Command Reference](./commands.md) for accepted command forms, options, and errors.
