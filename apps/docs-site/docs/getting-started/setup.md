---
title: Interactive Setup
description: Choose curated documentation and configure or remove the detected Grok Build user-level MCP registration through a reviewed setup flow.
---

# Interactive Setup

```sh
nekosearch setup
```

Setup helps you install optional curated snapshots and connect Grok Build CLI when it is detected. It runs only when invoked explicitly; installing or upgrading the npm package does not run it.

## Choose documentation

Select the curated snapshots you want to install. The current choices are NestJS 11 and 12. Installed choices are marked and unavailable for reinstallation through setup. You can continue without selecting documentation.

Setup is for curated sources. Use [`add --dir`, `add --github`, or `add --from`](../cli/commands.md#add) for custom documentation.

## Configure Grok Build CLI

Setup detects the Grok Build CLI executable (`grok`) on `PATH` and inspects its MCP registry. If it is available and its registration can be inspected safely, setup offers the user-level NekoSearch registration. Other MCP clients are not automatically detected by the current setup adapter.

- Use **Space** to select or unselect a choice, **Enter** to continue, and **Backspace** to return to the previous step.
- An existing matching registration is selected initially and remains unchanged if kept selected.
- Deselecting the configured Grok Build registration proposes removing only that verified NekoSearch user registration.

::: warning Review removals
Deselecting the configured provider can remove its verified NekoSearch registration after confirmation. It does not uninstall Grok Build, delete your documentation, or remove unrelated MCP registrations.
:::

See [Client Configuration](../mcp/client-configuration.md) for the Grok Build commands and manual stdio setup for other MCP clients.

## Review and confirm

Before changes begin, setup displays the selected documentation and Grok Build action, including the user scope and target registry. Backspace returns to provider selection; canceling before application leaves configuration and documentation unchanged.

After confirmation, selected documentation is resolved, downloaded, indexed, validated, and installed. The Grok Build registration is then applied through its CLI. A failure in one operation is reported while remaining operations continue; setup is not one transaction spanning the source and provider.

Registration uses the absolute Node executable, the installed CLI entry point, and `serve`. Setup does not create a daemon, launch a shell server, or configure an HTTP listener.

## Configuration conflicts

NekoSearch delegates registry changes to the Grok Build CLI and verifies the result. A same-name registration in another scope, an ambiguous origin, or a different command is treated as a conflict and left unchanged.

Configure the provider directly without the interactive flow:

```sh
nekosearch mcp configure grok-build
nekosearch mcp remove grok-build
```

## Non-interactive use

Setup requires both stdin and stdout to be terminals. Otherwise it exits with code `2` before reading client configuration, downloading documentation, or writing settings.

Use explicit commands in scripts instead:

```sh
nekosearch add --dir ./docs --id my-api@1
nekosearch mcp configure grok-build
```

Restart or reconnect the client after registration or snapshot changes. A written registration alone does not prove that the client connected successfully.
