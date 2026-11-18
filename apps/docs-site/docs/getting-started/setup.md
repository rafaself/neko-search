---
title: Interactive Setup
description: Choose curated documentation, optionally install the Qwen3 model, and configure the detected Grok Build user-level MCP registration through a reviewed setup flow.
---

# Interactive Setup

```sh
nekosearch setup
```

Setup helps you install optional curated snapshots and connect Grok Build CLI when it is detected. It runs only when invoked explicitly; installing or upgrading the npm package does not run it.

## Choose documentation

Select the curated snapshots you want to install. The current choices are NestJS 11 and 12. Installed choices are marked and unavailable for reinstallation through setup. You can continue without selecting documentation.

Setup is for curated sources. Use [`add --dir`, `add --github`, or `add --from`](../cli/commands.md#add) for custom documentation.

## Optional Semantic Search

Setup offers **Install now** or **Skip for now** for Qwen3-Embedding-0.6B (approximately 614 MB). Skipping finishes setup normally, keeps Semantic Search disabled, and does not download the model or load the ML runtime. Lexical Search remains available.

If you choose **Install now**, setup downloads and validates the pinned model after you confirm the review. It generates embeddings for already installed snapshots, validates them, and enables Semantic Search only when the model, runtime, and snapshots are ready. Newly selected documentation is then ingested with embeddings. If model installation or embedding generation fails, setup reports the failure and leaves Semantic Search disabled; the installed model or completed snapshots can be reused on a later attempt.

Use `nekosearch embeddings disable` to turn off Semantic Search later. This preserves the model and existing vectors. Model removal requires disabling Semantic Search first.

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

Before changes begin, setup displays the selected documentation, Semantic Search action, and Grok Build action, including the user scope and target registry. Backspace returns to provider selection; canceling before application leaves configuration and documentation unchanged.

After confirmation, the optional model and existing snapshot embeddings are validated before Semantic Search is enabled. Selected documentation is then resolved, downloaded, indexed, validated, and installed. The Grok Build registration is applied through its CLI. A failure in one operation is reported while remaining operations continue; setup is not one transaction spanning the model, sources, and provider.

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
