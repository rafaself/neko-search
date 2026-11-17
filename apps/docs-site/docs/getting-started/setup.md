---
title: Interactive Setup
description: Choose curated documentation and configure or remove user-level MCP client registrations through a reviewed setup flow.
---

# Interactive Setup

```sh
nekosearch setup
```

Setup helps you install optional curated snapshots and connect supported MCP clients. It runs only when invoked explicitly; installing or upgrading the npm package does not run it.

## Choose documentation

Select the curated snapshots you want to install. The current choices are NestJS 11 and 12. Installed choices are marked and unavailable for reinstallation through setup. You can continue without selecting documentation.

Setup is for curated sources. Use [`add --dir`, `add --github`, or `add --from`](../cli/commands.md#add) for custom documentation.

## Choose clients

Setup inspects supported user-level client configurations and application availability. It distinguishes clients that are ready, already configured, in conflict, unavailable, or manual-only.

- Use **Space** to select or unselect a choice, **Enter** to continue, and **Backspace** to return to the previous step.
- Existing matching registrations are selected initially.
- Keeping a configured client selected leaves a matching registration unchanged.
- Deselecting a configured client proposes removal of its NekoSearch registration.
- An older Codex registration can be marked for replacement in the selection and review.

::: warning Review removals
Deselecting an already configured client can remove its NekoSearch registration after confirmation. It does not uninstall the client, delete your documentation, or remove unrelated MCP registrations.
:::

See [Client Configuration](../mcp/client-configuration.md) for the implemented adapters and their locations.

## Review and confirm

Before changes begin, setup displays the selected documentation and provider actions, including the scope and configuration target. Backspace returns to client selection; canceling before application leaves configuration and documentation unchanged.

After confirmation, selected documentation is resolved, downloaded, indexed, validated, and installed. Selected client changes are then applied. A failure in one operation is reported while remaining operations continue; setup is not one transaction spanning every source and client.

Registration uses the absolute Node executable, the installed CLI entry point, and `serve`. Setup does not create a daemon, launch a shell server, or configure an HTTP listener.

## Configuration conflicts

The adapters preserve unrelated values and supported comments. Unsafe paths, unreadable or unparseable files, managed configurations, and conflicting registrations can make an operation unavailable or cause it to fail. Setup does not silently overwrite those conflicts.

For intentional Codex replacement outside setup:

```sh
nekosearch mcp configure codex --force
```

## Non-interactive use

Setup requires both stdin and stdout to be terminals. Otherwise it exits with code `2` before reading client configuration, downloading documentation, or writing settings.

Use explicit commands in scripts instead:

```sh
nekosearch add --dir ./docs --id my-api@1
nekosearch mcp configure codex
```

Restart or reconnect the client after registration or snapshot changes. A written registration alone does not prove that the client connected successfully.
