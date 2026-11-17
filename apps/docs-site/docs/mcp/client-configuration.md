---
title: Client Configuration
description: Configure supported MCP clients, understand automatic and manual adapters, and verify the local stdio server connection.
---

# Client Configuration

Start with:

```sh
nekosearch setup
```

Setup inspects client availability and user-level configuration, then proposes eligible registrations. Confirmed registrations use the current absolute Node executable, the installed NekoSearch CLI entry point, and `serve` as a separate argument.

## Implemented adapters

The table describes the adapters in this repository. Automated tests use configuration fixtures and mocked commands; they do not establish that every listed client has completed a live MCP handshake.

| Client                                      | Setup behavior                               | User-level target                                                               |
| ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Codex CLI                                   | Automatic through its MCP commands           | Managed by the installed `codex` CLI                                            |
| Codex desktop without CLI                   | Manual-only detection                        | User MCP settings; setup does not edit them                                     |
| Claude Code                                 | Automatic JSON/JSONC edit                    | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`                          |
| Cursor                                      | Automatic JSON/JSONC edit                    | `~/.cursor/mcp.json`                                                            |
| OpenCode                                    | Automatic JSON/JSONC edit                    | `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`, or existing `.jsonc`    |
| Grok Build CLI                              | Automatic TOML edit                          | `${GROK_HOME:-~/.grok}/config.toml`                                             |
| GitHub Copilot CLI / VS Code Copilot Global | Automatic JSON/JSONC edit to the shared file | `${COPILOT_HOME:-~/.copilot}/mcp-config.json`                                   |
| Cline                                       | Automatic JSON/JSONC edit                    | `$CLINE_MCP_SETTINGS_PATH`, or `~/.cline/data/settings/cline_mcp_settings.json` |
| Kiro                                        | Automatic JSON/JSONC edit                    | `~/.kiro/settings/mcp.json`                                                     |
| Zed                                         | Automatic JSON/JSONC edit                    | Platform-specific settings file below                                           |
| Junie                                       | Manual-only                                  | `~/.junie/mcp/mcp.json`                                                         |
| Google Antigravity CLI (`agy`)              | Automatic JSON/JSONC edit                    | `~/.gemini/config/mcp_config.json`                                              |

Zed paths are `${XDG_CONFIG_HOME:-~/.config}/zed/settings.json` on Linux, `~/Library/Application Support/Zed/settings.json` on macOS, and `%APPDATA%\Zed\settings.json` on Windows (with a home-based `AppData\Roaming` fallback).

Automatic setup depends on the adapter detecting the client or an existing eligible registration. Existing conflicting or managed files can make a client unavailable. If both OpenCode `.json` and `.jsonc` files exist, setup reports the ambiguity instead of choosing one. Legacy VS Code Local-harness settings are not edited by the Copilot adapter. Grok Build refers to the local CLI, not Grok in a browser.

## Codex command

```sh
nekosearch mcp configure codex
```

This checks the existing user registration through `codex mcp list --json`, then adds the server when missing. An identical registration is unchanged. To intentionally replace a different entry named `nekosearch`:

```sh
nekosearch mcp configure codex --force
```

The command requires the Codex CLI on `PATH`; it does not require a running server or download documentation.

## Manual registration shapes

The following examples mirror implemented adapter shapes. Replace the example absolute paths with your supported Node executable and installed CLI entry point. Find your global npm package directory with `npm root --global`; the entry point is `nekosearch/dist/apps/nekosearch/cli.js` beneath it. Use `node -p "process.execPath"` to inspect the Node executable.

::: code-group

```json [Claude Code / Cursor]
{
  "mcpServers": {
    "nekosearch": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": [
        "/usr/local/lib/node_modules/nekosearch/dist/apps/nekosearch/cli.js",
        "serve"
      ]
    }
  }
}
```

```json [OpenCode]
{
  "mcp": {
    "servers": {
      "nekosearch": {
        "type": "local",
        "command": [
          "/usr/local/bin/node",
          "/usr/local/lib/node_modules/nekosearch/dist/apps/nekosearch/cli.js",
          "serve"
        ]
      }
    }
  }
}
```

```json [Junie — manual]
{
  "mcpServers": {
    "nekosearch": {
      "command": "/usr/local/bin/node",
      "args": [
        "/usr/local/lib/node_modules/nekosearch/dist/apps/nekosearch/cli.js",
        "serve"
      ]
    }
  }
}
```

:::

Merge the appropriate entry into existing configuration. Keep command arguments separate; do not combine executable paths and arguments into a shell string. Use the client's own MCP settings for clients without an automatic adapter.

## Verify a connection

1. Restart or reconnect the MCP client after configuration changes.
2. Inspect the client's server status and stderr logs if startup fails.
3. Confirm that `list_docs`, `search_docs`, and `fetch_docs` are available.
4. Call `list_docs` and make a [first search](../getting-started/quick-start.md#search-then-fetch).

A written registration is not proof of a successful connection. If Node has moved after a version-manager change, rerun setup or the Codex configuration command for the current installation.

## Remove a registration

Run `nekosearch setup`, deselect the already configured provider, and review the proposed removal before confirming. Removal checks that the registration still matches this NekoSearch installation. Conflicting entries are not silently deleted.

This removes the client registration, not the CLI or documentation catalog. Use [`remove`](../cli/commands.md#remove) to remove an installed snapshot.
