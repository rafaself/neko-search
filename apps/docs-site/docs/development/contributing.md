---
title: Contributing
description: Contribute focused, validated changes to NekoSearch while preserving its runtime, contracts, and documentation accuracy.
---

# Contributing

NekoSearch is MIT-licensed. Start with the [development environment](./development-setup.md) and the repository's [working agreements](https://github.com/rafaself/nekosearch/blob/main/AGENTS.md).

## Choose the owning boundary

Use the [Architecture Overview](../architecture/overview.md) to locate the responsibility you are changing. Source-specific transformations belong in integrations; generic parsing and retrieval belong in the engine; public command behavior belongs in the CLI; tool schemas and presentation belong at the MCP boundary.

Keep changes focused. Avoid adding dependencies or abstractions unless they solve a concrete requirement. Production dependencies require confirmation unless highly consolidated, safe, and trusted under the repository's working agreements.

## Preserve observable behavior

- Validate external inputs and fail explicitly.
- Keep source/version isolation and exact-selector behavior intact.
- Preserve the read-only, offline serving boundary and protocol-only stdout.
- Keep snapshot hashes, schema versions, and stored formats explicit when their structures change.
- Keep optional source installation separate from package installation and server startup.

Add behavior-focused coverage when changing domain behavior. Never weaken tests to hide a failure; investigate the underlying contract first.

## Required validation

Run formatting first:

```sh
pnpm format
```

Then run these in parallel, as required by `AGENTS.md`:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

The repository uses npm workspaces and `package-lock.json` for dependency installation. These `pnpm` invocations run the existing package scripts; they do not imply migrating dependency management to pnpm. Fix failures and rerun the affected checks. Report checks that could not be completed.

For website changes, also run:

```sh
npm run docs:site:build
npm run docs:site:check
```

Review rendering, navigation, local search, links, assets, and both themes. Tests for the CLI do not verify browser presentation.

## Documentation accuracy

Inspect implementation, public schemas/types, and relevant tests before describing behavior. Use current CLI forms and MCP catalog schemas. Validate examples with a temporary catalog rather than editing a contributor's real MCP registrations.

These pages describe NekoSearch itself. The repository's separate `apps/nekosearch/content/mcp-protocol` directory supplies bundled reference content; it is not the source directory for this website. Do not copy external framework documentation into the product site.

## Share a change

Use a focused issue or pull request in [rafaself/nekosearch](https://github.com/rafaself/nekosearch). Explain the concrete behavior change, why it matters, validation results, and any limitations. Follow the repository's conventional commit format and avoid including generated website output, personal catalog data, or credentials.
