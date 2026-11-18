---
title: Client Configuration
description: Configure Codex, Claude Code, Cursor, or Grok Build, or launch NekoSearch from another stdio client.
---

# Client Configuration

NekoSearch serves MCP over stdio. Run `nekosearch setup` to select a detected MCP client and review its user registration.

| Provider ID   | Detection                            | User registration                              |
| ------------- | ------------------------------------ | ---------------------------------------------- |
| `codex`       | `codex` on `PATH`                    | Managed by `codex mcp`                         |
| `claude-code` | `claude` on `PATH`                   | Managed by `claude mcp` with user scope        |
| `cursor`      | `cursor` or `cursor-agent` on `PATH` | The `nekosearch` entry in `~/.cursor/mcp.json` |
| `grok-build`  | `grok` on `PATH`                     | Managed by `grok mcp` with user scope          |

An existing project entry can take precedence over a user registration. To inspect or change a project registration, open the client's MCP settings for that project.

## Configure or remove directly

```sh
nekosearch mcp configure codex
nekosearch mcp remove codex
```

Replace `codex` with the provider ID for your client. `configure` adds the user registration when absent and leaves an exact match alone. `remove` removes a matching user registration. A customized or conflicting entry requires review in the client. Restart or reconnect your MCP client, then call `list_docs` to verify the connection.

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

Use `nekosearch mcp remove <provider>` for a verified user registration. Remove manual registrations from the corresponding MCP client's settings. Removing a registration does not uninstall NekoSearch or remove any documentation snapshots.
