---
title: Retrieval
description: Understand source-scoped full-text search, per-source ranking, bounded fetches, continuation cursors, and internal references.
---

# Retrieval

Each loaded snapshot has a `DocumentationSearchService` backed by a read-only SQLite store. The MCP catalog layer selects services by exact selector, aggregates search groups, and presents fetch results with source metadata.

## Search input

Queries are treated as text, not executable SQL or arbitrary FTS syntax. Validation bounds query length to 256 characters and the tokenized query to 32 distinct terms. Unicode letters, numbers, and underscores form terms. A query without searchable tokens returns no results.

The engine quotes terms and combines alternatives. For multiple terms, an additional contiguous phrase clause improves phrase relevance while retaining individual-term recall. It rejects forbidden control characters and invalid result limits.

## Ranking within a source

SQLite FTS5 provides full-text matching, snippets, and weighted BM25 ranking across the indexed fields. Stable document and chunk identifiers break ties. Results include `chunkId`, `documentId`, title, canonical URL, source revision, excerpt, and score.

The engine has an internal result cap of 50, but the **public MCP contract caps the entire response at 10**. Internal engine limits are not extra MCP options.

## Optional snapshot embeddings

Snapshot builds may include one normalized 1024-dimensional Float32 vector for every canonical chunk. The vectors live in a separate `documentation_embeddings(chunk_id, embedding)` table and do not copy chunk text or add a foreign key to the FTS5 virtual table. The FTS5 schema and BM25 queries are unchanged.

Hybrid manifests record the supported Qwen3 model revision and ONNX artifact checksum along with dimensions, data type, pooling, normalization, query-instruction version, and embedding-pipeline version. Validation checks the metadata, exact Float32 BLOB size, vector normalization, and one-to-one chunk IDs against the corpus before promotion. Lexical-only snapshots omit both the metadata and the embeddings table. The current MCP search path remains lexical; snapshot embedding persistence does not yet enable hybrid ranking.

## Combining selected sources

The MCP layer resolves every selector before searching any index. It rejects unknown or duplicated selectors rather than dropping them or broadening the request.

Each source is searched independently. Results are allocated round-robin by rank, following the requested source order, until the total requested limit is exhausted. Output remains grouped by source and preserves source-local ranking. Scores from different snapshots are not globally compared.

For a small budget and many sources, some groups can be empty even though their index has hits. Empty groups retain their source metadata; `totalResults` counts returned hits across all groups.

## Fetching sections

Fetch uses one selector and a deterministic document ID. If `sectionId` is supplied, the store resolves the chunk's section and returns rows with that section's heading path and canonical URL. A search hit's `chunkId` is the accepted section selector; fetching a section can therefore include several chunks belonging to it.

Missing documents or sections return `found: false` with empty sections/references. Invalid input or a stale cursor is an error, not a missing-document result.

## Response bounds and cursors

Fetch pagination uses a 12,000-character budget for section Markdown and section framing. It does not promise a 12,000-character limit for the entire JSON/text response envelope.

When content remains, the response sets `truncated: true` and supplies `nextCursor`. The cursor binds the documentation identity, document, optional section, revision, and selected content. Continue with the same selector, document ID, and section ID; changing that scope or using a stale cursor fails.

Treat cursors as opaque values. They are not offsets for callers to construct.

## Following references

New-format snapshots store resolved links with positions and target IDs. A fetched page returns at most 100 references whose complete link occurrence lies within the visible Markdown. Each contains the original `href`, target `documentId`, and optional `sectionId`.

Use those IDs with the same source selector to fetch the target offline. Reference following does not cross snapshots or fetch external URLs.

The exact public schemas and examples are in the [MCP Tool Reference](../mcp/tools.md).
