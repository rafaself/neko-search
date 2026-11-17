---
title: Documentation Sources
description: Choose between curated sources, local Markdown and MDX, public GitHub directories, and portable snapshots.
---

# Documentation Sources

A source has an identity such as `my-api@1`: `my-api` is the documentation ID and `1` is its version. Each installed snapshot also has a revision describing the content that was indexed.

| Mechanism                     | Command                                  | Network      | Update tracking         |
| ----------------------------- | ---------------------------------------- | ------------ | ----------------------- |
| Curated NestJS 11 or 12       | `add nestjs@12`                          | GitHub HTTPS | Curated recipe tracking |
| Local documentation directory | `add --dir ./docs --id my-api@1`         | None         | Untracked               |
| Public GitHub directory       | `add --github … --ref … --path … --id …` | GitHub HTTPS | Untracked               |
| Existing portable snapshot    | `add --from ./snapshot`                  | None         | Untracked               |

The bundled `mcp@2025-11-25` source is a small protocol summary included with the CLI. It is not the full upstream specification or this NekoSearch website.

## Curated sources

```sh
nekosearch add nestjs@12
```

The current curated integration supports NestJS major versions **11 and 12**. It resolves a ref from the official `nestjs/docs.nestjs.com` repository, selects documentation through its version-specific recipe, applies the NestJS transformation, and builds a validated snapshot locally.

The current recipes use the `11.0.0` tag for version 11 and `master` for version 12. The v12 recipe checks the migration guide's major-version compatibility. An unresolved ref or incompatible guide causes an error rather than silently choosing a different version.

These commands build from official documentation files; they do not download a prebuilt NestJS database. See [Updating & Removing](./updating.md) for tracking and replacement behavior.

## Local directories

```sh
nekosearch add --dir ./docs --id my-api@1
```

Local discovery recursively reads regular files with lowercase `.md` or `.mdx` extensions. It skips `.git`, `node_modules`, and symlinks by default. The public CLI uses these defaults; it does not expose discovery overrides as command flags.

| Default bound              | Value   |
| -------------------------- | ------- |
| Traversal depth            | 32      |
| Directory entries examined | 100,000 |
| Documentation files        | 10,000  |
| Individual file size       | 4 MiB   |
| Total content              | 64 MiB  |

The input must be a real directory; `add --dir` rejects a symlink as its input directory. Empty corpora, unsafe paths, read errors, and exceeded bounds fail the operation. It builds in a private temporary directory, validates the snapshot, and installs it only after success.

### What gets indexed?

Markdown parsing extracts static content such as headings, paragraphs, lists, tables, code examples, and links. MDX is parsed without compiling or running it. Imports, expressions, and dynamic JSX attributes are unsupported and produce diagnostics; static content can still be indexed.

NekoSearch does not run components, install a documentation project's dependencies, execute repository code, or crawl rendered websites. PDF, HTML files, and other extensions are not local ingestion formats.

## Public GitHub repositories

```sh
nekosearch add --github https://github.com/modelcontextprotocol/modelcontextprotocol \
  --ref 2025-11-25 --path docs --id mcp-source@2025-11-25
```

This installs supported files from one directory of a **public** repository. Supply the repository root URL, a branch/tag/commit ref, a relative documentation path, and a source selector. Use `--path .` to select the repository root.

The implementation:

1. Accepts only `https://github.com/<owner>/<repository>` URLs, optionally ending in `.git`.
2. Resolves `--ref` to an exact commit and reads that commit's Git tree.
3. Downloads only regular `.md` and `.mdx` files under `--path`, excluding `.git` and `node_modules` paths.
4. Skips symlinks and submodules, parses the files, and installs a validated local snapshot.

It rejects credentials, custom ports, query strings, fragments, branch/file URLs, unsafe relative paths, unsupported hosts, and truncated Git trees. Requests use an allowlist of GitHub API/raw hosts and reject redirects. Content is bounded to 10,000 files, 4 MiB per file, and 64 MiB total, with 15-second request timeouts and a 120-second ingestion timeout.

The manifest records the repository URL, requested ref, docs directory, and resolved commit. This provenance does **not** enable automatic updates. No authentication flag or private-repository ingestion is exposed by this command.

## Custom snapshots

```sh
nekosearch add --from ./snapshots/my-api
```

Install a directory containing `corpus.json`, `index.sqlite`, and `manifest.json`. The directory may be built by NekoSearch or another producer that follows its supported formats. NekoSearch validates the files, identities, hashes, and index before installation.

An existing selector is never silently overwritten by an `add` command. Use a distinct version or follow the [custom replacement procedure](./updating.md#custom-documentation).
