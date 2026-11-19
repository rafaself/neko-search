<p align="center">
  <a href="https://nekosearch.pages.dev/"><img src="https://raw.githubusercontent.com/rafaself/nekosearch/main/assets/nekosearch.png" alt="NekoSearch cat reading a book" width="144" /></a>
</p>

<h1 align="center">NekoSearch</h1>

<p align="center">Local documentation search for AI coding agents.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nekosearch"><img src="https://img.shields.io/npm/v/nekosearch.svg" alt="npm package version" /></a>
  <a href="https://github.com/rafaself/nekosearch/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/nekosearch.svg" alt="MIT license" /></a>
  <a href="https://www.npmjs.com/package/nekosearch"><img src="https://img.shields.io/npm/dm/nekosearch.svg" alt="Monthly npm downloads" /></a>
  <a href="https://github.com/rafaself/nekosearch/actions/workflows/ci.yml"><img src="https://github.com/rafaself/nekosearch/actions/workflows/ci.yml/badge.svg?branch=main" alt="Build status on main" /></a>
  <a href="https://nekosearch.pages.dev/"><img src="https://img.shields.io/website.svg?url=https%3A%2F%2Fnekosearch.pages.dev%2F&amp;up_message=online" alt="Documentation website status" /></a>
</p>

## Description

NekoSearch is a read-only MCP server for local documentation snapshots. Index your own Markdown or MDX, or install a curated source such as NestJS. Your MCP client can search the snapshots and fetch sections over stdio, even offline.

Search uses SQLite FTS5 and BM25 by default. On Linux x64, you can add local Qwen3 embeddings for Hybrid Search.

## Quick start

Use Node.js 24.15 or newer and npm.

```sh
npm install --global nekosearch && nekosearch setup
```

In setup, select your MCP client and choose `nestjs@12` for the example below. The bundled MCP reference is available immediately. You can skip the model and enable Hybrid Search later.

Once your client connects, try asking it to search `nestjs@12` for dependency injection providers and cite a matching section.

## Documentation

- [Quick start walkthrough](https://nekosearch.pages.dev/getting-started/quick-start)
- [Add your own documentation](https://nekosearch.pages.dev/guides/custom-documentation)
- [Configure an MCP client](https://nekosearch.pages.dev/mcp/client-configuration)
- [Enable Hybrid Search and see benchmark results](https://nekosearch.pages.dev/guides/hybrid-search)
- [CLI command reference](https://nekosearch.pages.dev/cli/commands)
- [Release notes](https://github.com/rafaself/nekosearch/releases)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout and development checks.

## License

[MIT](LICENSE)
