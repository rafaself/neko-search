---
title: Interactive Setup
description: Choose curated documentation, optionally install the Qwen3 model, and configure user registrations for detected MCP clients through a reviewed setup flow.
---

# Interactive Setup

```sh
nekosearch setup
```

Setup helps you install optional curated snapshots and connect supported MCP clients. It runs only when invoked explicitly; installing or upgrading the npm package does not run it.

## Choose documentation

Select the curated snapshots you want to install. The current choices are NestJS 11 and 12. Installed choices are marked and unavailable for reinstallation through setup. You can continue without selecting documentation.

Setup is for curated sources. Use [`add --dir`, `add --github`, or `add --from`](../cli/commands.md#add) for custom documentation.

## Choose MCP clients

Setup checks for Codex, Claude Code, Cursor, and Grok Build executables on `PATH`. When setup can verify the user registry, it offers a NekoSearch registration for that client.

- Use **Space** to select or unselect a choice, **Enter** to continue, and **Backspace** to return to the previous step.
- An existing matching registration is selected initially and remains unchanged if kept selected.
- Deselecting the configured client proposes removing only that verified NekoSearch user registration.

::: warning Review removals
Deselecting the configured provider can remove its verified NekoSearch registration after confirmation. It does not uninstall the client, delete your documentation, or remove unrelated MCP registrations.
:::

See [Client Configuration](../mcp/client-configuration.md) for provider IDs and manual stdio setup.

## Optional Semantic Search

Setup offers **Install now** or **Skip for now** for Qwen3-Embedding-0.6B (approximately 625 MB across the release assets). Skipping finishes setup normally, keeps Semantic Search disabled, and does not download the model or load the ML runtime. Lexical Search remains available.

If you choose **Install now**, setup checks that the optional local inference runtime is available before downloading the pinned model. After you confirm the review, it downloads and validates Qwen3, generates embeddings for already installed snapshots, validates them, and enables Semantic Search only when the model, runtime, and snapshots are ready. Newly selected documentation is then ingested with embeddings. If the runtime is missing, setup reports how to install it before downloading the model. If model installation or embedding generation fails, Semantic Search stays disabled; the installed model or completed snapshots can be reused on a later attempt.

Use `nekosearch embeddings disable` to turn off Semantic Search later. This preserves the model and existing vectors. Model removal requires disabling Semantic Search first.

For the complete later-install flow, supported runtime, storage paths, offline behavior, and troubleshooting steps, see [Local Embeddings and Hybrid Search](../guides/hybrid-search.md).

## Review and confirm

Before changes begin, setup displays the selected documentation, Semantic Search action, and provider actions, including the user scope and target registry. Backspace returns to provider selection; canceling before application leaves configuration and documentation unchanged.

After confirmation, the optional model and existing snapshot embeddings are validated before Semantic Search is enabled. Selected documentation is then resolved, downloaded, indexed, validated, and installed. Each selected provider then applies its registration changes. A failure in one operation is reported while remaining operations continue; setup is not one transaction spanning the model, sources, and provider.

Registration uses the absolute Node executable, the installed CLI entry point, and `serve`. Setup does not create a daemon, launch a shell server, or configure an HTTP listener.

## Configuration conflicts

NekoSearch treats a different command, customized entry, or ambiguous registration as a conflict. Review the client settings before making changes.

Configure the provider directly without the interactive flow:

```sh
nekosearch mcp configure codex
nekosearch mcp remove codex
```

## Non-interactive use

Setup requires both stdin and stdout to be terminals. Otherwise it exits with code `2` before reading client configuration, downloading documentation, or writing settings.

Use explicit commands in scripts instead:

```sh
nekosearch add --dir ./docs --id my-api@1
nekosearch mcp configure codex
```

Restart or reconnect the client after registration or snapshot changes. A written registration alone does not prove that the client connected successfully.
