---
title: Command Reference
description: Every public NekoSearch command, with exact syntax, options, examples, behavior, and relevant errors.
---

# Command Reference

This page describes the public `nekosearch` executable. Contributor-only indexer scripts are separate; see [Development Setup](../development/development-setup.md).

## Help

```sh
nekosearch --help
nekosearch -h
```

Print usage and network-access notes to stdout, then exit successfully. Invoking `nekosearch` with no command also prints usage. There is no public `--version` flag; `status` includes the CLI version.

## setup

```sh
nekosearch setup
```

Interactively choose curated snapshots and, when Grok Build CLI is detected, its user-level NekoSearch registration. No arguments or options are accepted. Changes start only after the final review and confirmation. Deselecting an existing matching Grok registration proposes removing it.

**Errors:** requires interactive stdin/stdout; Grok Build inspection conflicts and individual download/configuration failures are reported. Remaining confirmed operations can continue after a failure.

See [Interactive Setup](../getting-started/setup.md).

## build

```text
nekosearch build <docs-dir> --id <source@version> --output <snapshot-dir> [--clean]
```

Build a local Markdown/MDX snapshot without installing it. Exactly one input directory and both required options must be supplied.

| Argument or option        | Required | Behavior                                                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------- |
| `<docs-dir>`              | Yes      | Local source directory, resolved from the working directory               |
| `--id <source@version>`   | Yes      | Documentation identity for the built snapshot                             |
| `--output <snapshot-dir>` | Yes      | Output directory for corpus, index, and manifest                          |
| `--clean`                 | No       | Disable reuse of compatible previous build output; default is incremental |

```sh
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api
nekosearch build ./docs --id my-api@1 --output ./snapshots/my-api --clean
```

The command writes `corpus.json`, `index.sqlite`, and `manifest.json`. It prints source revision, document/chunk counts, output location, and any diagnostics to stderr. Network access is not required.

**Errors:** missing or malformed identity/options, unavailable or empty input, overlapping input/output, unsupported content, exceeded discovery bounds, unsafe output paths, and build/validation failures.

## add

Choose one of the four forms below. `add` refuses to overwrite an existing selector.

### Local directory

```text
nekosearch add --dir <docs-dir> --id <source@version>
```

```sh
nekosearch add --dir ./docs --id my-api@1
```

Build in a private temporary directory, validate, and install into the user catalog. This form takes exactly the shown arguments in the shown order. It has no `--output`, `--clean`, or discovery options. It is offline.

**Errors:** input is missing, is a symlink, is not a directory, or cannot be indexed; identity is invalid; selector exists; snapshot fails validation or activation.

### Public GitHub directory

```text
nekosearch add --github <repository-url> --ref <ref> --path <docs-dir> --id <source@version>
```

| Option                      | Required | Behavior                                                  |
| --------------------------- | -------- | --------------------------------------------------------- |
| `--github <repository-url>` | Yes      | Public `https://github.com/<owner>/<repository>` root URL |
| `--ref <ref>`               | Yes      | Branch, tag, or commit to resolve and pin                 |
| `--path <docs-dir>`         | Yes      | Safe relative directory; `.` selects the repository root  |
| `--id <source@version>`     | Yes      | Installed source identity                                 |

```sh
nekosearch add --github https://github.com/modelcontextprotocol/modelcontextprotocol \
  --ref 2025-11-25 --path docs --id mcp-source@2025-11-25
```

Fetch only supported regular Markdown/MDX files from the resolved commit, build locally, validate, and install. Options are parsed by name. The imported source is **untracked**, including when the requested ref is a branch.

**Errors:** missing/unknown options, unsupported or unsafe URL/ref/path, unavailable repository/ref, truncated Git tree, no supported files, timeouts/size limits, invalid UTF-8, duplicate selector, or snapshot validation failure. There is no private-repository authentication option.

See [Documentation Sources](../guides/documentation-sources.md#public-github-repositories) for limits.

### Portable snapshot directory

```text
nekosearch add --from <snapshot-dir>
```

```sh
nekosearch add --from ./snapshots/my-api
```

Validate and install the three-file portable snapshot. Identity comes from the manifest; this form has no `--id` option. It is offline and copies the validated files into the catalog.

**Errors:** missing files, symlinks, unsupported format/schema, hash or identity mismatch, corrupt index, unsafe catalog, or duplicate selector.

### Curated NestJS

```sh
nekosearch add nestjs@11
nekosearch add nestjs@12
```

Resolve the official curated recipe, download documentation over HTTPS, build and validate locally, and install with curated tracking. Only majors `11` and `12` are accepted. There are no options.

**Errors:** duplicate selector, unresolved recipe ref, network failure, incompatible major-version guide, or failed build/validation. No alternate ref is silently selected.

## list

```sh
nekosearch list
```

List validated bundled and installed catalog entries, including source/version, revision, and bundled/installed status. It is offline and accepts no arguments or options.

**Errors:** unreadable or invalid catalog/snapshot data. Use `status` for a diagnostic overview that can report valid entries alongside catalog errors.

## status

```text
nekosearch status [<source@version>] [--check-upstream]
```

| Argument or option | Default               | Behavior                                                                        |
| ------------------ | --------------------- | ------------------------------------------------------------------------------- |
| `<source@version>` | All available entries | Inspect only the selected snapshot when supplied                                |
| `--check-upstream` | Off                   | Resolve tracked refs over HTTPS without downloading docs or writing the catalog |

```sh
nekosearch status
nekosearch status my-api@1
nekosearch status nestjs@12 --check-upstream
```

Output includes CLI version, readability, active revision, origin, tracking, and upstream state. A changed upstream revision is informational and does not itself produce a nonzero exit. An upstream-check failure exits `1`.

**Errors:** malformed or missing selector, multiple selectors, repeated/unknown flags, corrupt snapshot/catalog, and failed upstream checks. Imported snapshots do not become tracked by using this flag.

## update

```sh
nekosearch update nestjs@11
nekosearch update nestjs@12
```

Update an already installed source associated with the matching curated recipe. No other sources or options are accepted. This requires HTTPS access and remains within the selected major. A validated replacement is activated after success; failure preserves the active snapshot. An unchanged snapshot reports `Already current`.

**Errors:** source not installed, source not associated with its recipe, ref/network/major compatibility failure, concurrent catalog change, or failed build/validation.

For imported sources, use the [custom replacement procedure](../guides/updating.md#custom-documentation).

## remove

```text
nekosearch remove <source@version>
```

```sh
nekosearch remove my-api@1
```

Remove one installed selector from the catalog and retire its snapshot files. It is offline. Filesystem cleanup problems can produce a warning after successful catalog removal.

**Errors:** selector missing or invalid, source not installed, attempt to remove a bundled source, unsafe catalog/files, or a concurrent change to the selected snapshot.

Existing MCP sessions retain their open indexes; restart them after removal.

## mcp configure

```text
nekosearch mcp configure <provider>
```

Configure the NekoSearch stdio server with a supported provider. The current provider is:

| Provider ID  | Behavior                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `grok-build` | Inspect Grok Build, add a user-level registration if absent, and verify the resulting registration |

```sh
nekosearch mcp configure grok-build
```

The command delegates to `grok inspect --json` and `grok mcp add --scope user nekosearch -- <node> <cli-entry-point> serve`. An exact matching registration is unchanged. NekoSearch does not directly edit Grok's configuration file and has no force option.

**Errors:** unknown provider, Grok Build CLI not detected on `PATH`, failed inspection or registration verification, conflicting or ambiguous same-name registration, or a failed Grok CLI command. The command exits with code `1` for these operational failures. Registration does not perform an MCP connection test.

## mcp remove

```text
nekosearch mcp remove <provider>
```

Remove a verified NekoSearch registration managed by the selected provider. The current supported provider is `grok-build`:

```sh
nekosearch mcp remove grok-build
```

Removal is idempotent when the registration is already absent. For Grok Build, NekoSearch first confirms that exactly one user-scope `nekosearch` registration matches this installation, delegates removal to `grok mcp remove --scope user nekosearch`, and verifies the result. Registrations with a different command, another scope, or an unknown origin are left unchanged.

**Errors:** unknown provider, Grok Build CLI not detected on `PATH`, unverified or conflicting registration, failed Grok CLI command, or a registration that remains after removal. Operational failures exit with code `1`.

## serve

```sh
nekosearch serve
```

Load the catalog, open validated indexes read-only, register the three public MCP tools, and communicate over stdio. No arguments or options are accepted. The client normally launches this process for you.

The process writes readiness and diagnostic messages to stderr. Set `DEBUG=1` in its environment to log tool timings and failures to stderr. Stdout is reserved for protocol traffic. There is no HTTP port, network listener, background updater, or hot reload.

**Errors:** unreadable catalog, invalid snapshot/index, duplicate selectors, or startup/transport failure. Restart after catalog changes. On normal stdin closure the process shuts down; signal shutdown uses exit codes `130` for SIGINT and `143` for SIGTERM.
