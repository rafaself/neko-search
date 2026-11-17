---
title: Client Configuration
description: Configure Grok Build CLI automatically or launch the NekoSearch stdio server from another MCP client.
---

# Client Configuration

NekoSearch serves MCP over stdio. Its current automatic setup adapter supports Grok Build CLI. Other MCP clients can be configured manually if they support launching a local stdio server; NekoSearch does not currently detect or edit their settings.

## Grok Build CLI setup

Run the interactive setup:

```sh
nekosearch setup
```

Setup offers Grok Build when the `grok` executable is on `PATH` and `grok inspect --json` returns a registration list that can be inspected safely. It configures the user-level MCP registry through the Grok CLI. NekoSearch does not edit the Grok TOML file directly.

| Provider ID  | Detection                             | Registration target                                     |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| `grok-build` | `grok` executable available on `PATH` | User MCP registry managed by `grok mcp` (`config.toml`) |

The user config path used to identify registration scope is `${GROK_HOME:-~/.grok}/config.toml`.

## Configure or remove directly

```sh
nekosearch mcp configure grok-build
nekosearch mcp remove grok-build
```

`configure` inspects existing registrations first. An exact matching user-level `stdio` registration is left unchanged. If the name `nekosearch` is available, NekoSearch asks Grok Build to add the server with the user scope and then inspects the result again.

`remove` deletes only a single verified user-level registration whose command matches this NekoSearch installation. A registration in another scope, with a different command, with unknown origin, or with multiple same-name entries is a conflict and is left unchanged. There is no force option.

Both commands require `grok` on `PATH`. Configuration errors, unsupported `grok inspect --json` output, and conflicts are reported as command failures. Neither command downloads documentation or verifies a live MCP connection.

## Launch from another MCP client

For a client with local stdio support, configure its own settings with these launch values:

```text
transport: stdio
command:   <absolute path to Node.js>
args:      <absolute path to the NekoSearch CLI>, serve
```

Find the Node executable with:

```sh
node -p "process.execPath"
```

For a global npm installation, `nekosearch/dist/apps/nekosearch/cli.js` is beneath the directory printed by:

```sh
npm root --global
```

Keep `command` and each argument separate in the client's configuration. The values above describe the process to launch, not a complete settings schema for every client; follow the client's own instructions for its configuration format.

After configuration, restart or reconnect the client, then verify that `list_docs`, `search_docs`, and `fetch_docs` are available. A written registration alone does not prove that the client connected successfully.

## Remove a registration

Use `nekosearch mcp remove grok-build` for a registration managed by the Grok Build adapter. Remove manual registrations from the corresponding MCP client's settings. Removing a registration does not uninstall NekoSearch or remove any documentation snapshots.
