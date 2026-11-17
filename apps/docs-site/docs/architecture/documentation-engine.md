---
title: Documentation Engine
description: Follow documentation through discovery, static parsing, normalization, link resolution, indexing, and snapshot validation.
---

# Documentation Engine

The engine is the reusable documentation layer. It owns source/corpus schemas, shared parsing and normalization, storage contracts, and retrieval. The indexer composes these capabilities into build workflows and source-specific integrations.

## 1. Discover source files {#discover-source-files}

Local discovery validates a root directory, traverses supported Markdown/MDX files in deterministic order, and applies explicit file/depth/size bounds. It computes a revision from ordered relative paths and content hashes.

Public GitHub ingestion resolves a ref to a commit, selects supported regular files from the Git tree, and supplies Git provenance to the same local builder. Curated NestJS discovery instead uses its integration's version recipe and transformation.

## 2. Parse static content {#parse-static-content}

The Markdown parser uses the MDX parser in parse-only mode and supports GitHub-flavored Markdown. It extracts frontmatter, headings, paragraphs, lists, tables, code examples, static JSX, and links.

It does not compile or execute MDX. Unsupported imports, expressions, and dynamic attributes produce diagnostics. Parsing failures include source-path context; callers surface diagnostics rather than treating dynamically generated content as if it had rendered.

## 3. Normalize and chunk {#normalize-and-chunk}

Normalization constructs documents and heading-based chunks with deterministic IDs, canonical URLs, source provenance, content hashes, and text suitable for search. The normalizer preserves static documentation and code examples while removing unsupported dynamic behavior.

Build configuration defaults to a maximum chunk size of 4,000 characters. This is a chunking target used by the builder, separate from the MCP fetch-response budget. The public CLI does not expose a chunk-size flag.

## 4. Resolve internal links {#resolve-internal-links}

Link resolution runs against the complete corpus. Supported relative, route, and fragment targets are mapped to indexed document and section IDs within the same source. Link occurrence offsets let retrieval return only references completely visible in the current page of fetched Markdown.

External and unresolved links stay in the document. They are not crawled. Every built index stores resolved references for links that target documents in the same corpus.

## 5. Write and validate the snapshot {#write-and-validate-snapshot}

The writer creates SQLite full-text-search data and resolved-reference records. The builder writes `corpus.json` and a manifest containing source identity, hashes, counts, and pipeline versions, then validates consistency and integrity before promoting staged output.

Current builds use build manifest version 2 and resolved-link snapshot/index format 2. The runtime uses a smaller manifest projection; the catalog validates supported complete build or runtime metadata as appropriate. Avoid assuming that the similarly named manifest, snapshot, schema, and index format versions are interchangeable.

## Incremental reuse

When a compatible prior build exists, the indexer compares source content hashes and pipeline metadata to identify added, modified, unchanged, and removed documents. Compatible unchanged documents can be reused; pipeline changes invalidate reuse when needed. Links are resolved against the current corpus before final output is activated.

`nekosearch build` uses incremental mode by default. `--clean` disables previous-output reuse. Neither mode installs the result automatically.

## Contributor guidance

Keep source-specific behavior in an integration, shared static-document behavior in the engine, catalog activation in the CLI catalog layer, and MCP presentation at the transport boundary. Keep format validation current when stored data changes, and test source isolation with the repository's fixtures.
