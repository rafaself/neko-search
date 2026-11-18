import type { DatabaseSync } from 'node:sqlite';
import {
  DocumentationEmbeddingSpaceSchema,
  type DocumentationEmbeddingSet,
  type DocumentationEmbeddingSpace,
  type DocumentationEmbeddingVector,
} from '../../domain/documentation-embedding.schemas.js';
import {
  DOCUMENTATION_EMBEDDINGS_SCHEMA,
  DOCUMENTATION_EMBEDDINGS_TABLE,
  normalizeIndexSchema,
} from './index-schema.js';

const EMBEDDING_BLOB_BYTES = 1024 * Float32Array.BYTES_PER_ELEMENT;
const NORMALIZED_VECTOR_TOLERANCE = 1e-3;

/** Validate that a complete embedding set maps one-to-one to canonical chunks. */
export function validateDocumentationEmbeddingSet(
  embeddingSet: DocumentationEmbeddingSet,
  expectedChunkIds: readonly string[],
): DocumentationEmbeddingVector[] {
  const metadata = DocumentationEmbeddingSpaceSchema.safeParse(
    embeddingSet.embeddingSpace,
  );
  if (!metadata.success) {
    throw new Error('Embedding metadata is incompatible with supported Qwen3');
  }
  const rawVectors: unknown = embeddingSet.vectors;
  if (!Array.isArray(rawVectors)) {
    throw new Error('Embedding generation did not return a vector list');
  }

  const expected = new Set(expectedChunkIds);
  if (expected.size !== expectedChunkIds.length) {
    throw new Error('Canonical corpus contains duplicate chunk identifiers');
  }

  const seen = new Set<string>();
  const vectors: DocumentationEmbeddingVector[] = [];
  for (const rawItem of rawVectors as unknown[]) {
    if (!isRecord(rawItem) || typeof rawItem.chunkId !== 'string') {
      throw new Error('Embedding row has an invalid chunk identifier');
    }
    const chunkId = rawItem.chunkId;
    if (!chunkId.trim()) {
      throw new Error('Embedding row has an invalid chunk identifier');
    }
    if (seen.has(chunkId)) {
      throw new Error(`Duplicate embedding for chunk ${chunkId}`);
    }
    if (!expected.has(chunkId)) {
      throw new Error(
        `Embedding references nonexistent corpus chunk ${chunkId}`,
      );
    }
    const vector = rawItem.vector;
    validateVector(vector, chunkId);
    seen.add(chunkId);
    vectors.push({ chunkId, vector });
  }

  if (seen.size !== expected.size) {
    const missing = [...expected].find((chunkId) => !seen.has(chunkId));
    throw new Error(
      missing
        ? `Missing embedding for corpus chunk ${missing}`
        : 'Embedding generation is incomplete',
    );
  }

  return vectors.sort((left, right) =>
    compareStrings(left.chunkId, right.chunkId),
  );
}

/** Replace the optional vector table inside the caller's SQLite transaction. */
export function writeDocumentationEmbeddings(
  database: DatabaseSync,
  vectors: readonly DocumentationEmbeddingVector[],
): void {
  database.exec(DOCUMENTATION_EMBEDDINGS_SCHEMA);
  const insert = database.prepare(
    `INSERT INTO ${DOCUMENTATION_EMBEDDINGS_TABLE} (chunk_id, embedding) VALUES (?, ?)`,
  );
  for (const { chunkId, vector } of vectors) {
    insert.run(chunkId, encodeFloat32Vector(vector));
  }
}

/** Validate vector rows against FTS chunk IDs and optional canonical corpus IDs. */
export function validateDocumentationEmbeddingTable(
  database: DatabaseSync,
  embeddingSpace: DocumentationEmbeddingSpace | undefined,
  indexedChunkIds: ReadonlySet<string>,
  canonicalChunkIds?: ReadonlySet<string>,
): void {
  const tableRow = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(DOCUMENTATION_EMBEDDINGS_TABLE);

  if (!embeddingSpace) {
    if (tableRow) {
      throw new Error(
        'SQLite contains embeddings that the snapshot manifest does not declare',
      );
    }
    return;
  }
  if (!DocumentationEmbeddingSpaceSchema.safeParse(embeddingSpace).success) {
    throw new Error('Snapshot embedding metadata is incompatible with Qwen3');
  }
  if (!tableRow || typeof tableRow.sql !== 'string') {
    throw new Error(
      'Snapshot declares embeddings but the vector table is missing',
    );
  }
  if (
    normalizeIndexSchema(tableRow.sql) !==
    normalizeIndexSchema(DOCUMENTATION_EMBEDDINGS_SCHEMA)
  ) {
    throw new Error('SQLite embedding table schema is incompatible');
  }
  if (
    database
      .prepare(`PRAGMA foreign_key_list(${DOCUMENTATION_EMBEDDINGS_TABLE})`)
      .all().length !== 0
  ) {
    throw new Error(
      'Embedding table must not reference the FTS5 virtual table',
    );
  }

  if (canonicalChunkIds && !sameSet(indexedChunkIds, canonicalChunkIds)) {
    throw new Error('SQLite chunk IDs do not match the canonical corpus');
  }

  const rows = database
    .prepare(
      `SELECT chunk_id AS chunkId, embedding FROM ${DOCUMENTATION_EMBEDDINGS_TABLE} ORDER BY chunk_id COLLATE BINARY ASC`,
    )
    .all();
  if (rows.length !== indexedChunkIds.size) {
    throw new Error(
      'SQLite embeddings are missing or exceed the documentation chunk count',
    );
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.chunkId !== 'string' || !row.chunkId.trim()) {
      throw new Error('SQLite contains an invalid embedding chunk identifier');
    }
    if (seen.has(row.chunkId)) {
      throw new Error(`SQLite contains duplicate embedding ${row.chunkId}`);
    }
    if (!indexedChunkIds.has(row.chunkId)) {
      throw new Error(
        `SQLite embedding references nonexistent indexed chunk ${row.chunkId}`,
      );
    }
    if (canonicalChunkIds && !canonicalChunkIds.has(row.chunkId)) {
      throw new Error(
        `SQLite embedding references nonexistent corpus chunk ${row.chunkId}`,
      );
    }
    seen.add(row.chunkId);
    validateFloat32Blob(row.embedding, row.chunkId);
  }

  for (const chunkId of indexedChunkIds) {
    if (!seen.has(chunkId)) {
      throw new Error(`Missing SQLite embedding for chunk ${chunkId}`);
    }
  }
}

/** Read a validated vector set for incremental snapshot reuse. */
export function readDocumentationEmbeddingVectors(
  database: DatabaseSync,
  embeddingSpace: DocumentationEmbeddingSpace,
  expectedChunkIds: ReadonlySet<string>,
): DocumentationEmbeddingVector[] {
  validateDocumentationEmbeddingTable(
    database,
    embeddingSpace,
    expectedChunkIds,
    expectedChunkIds,
  );
  const rawRows: unknown = database
    .prepare(
      `SELECT chunk_id AS chunkId, embedding FROM ${DOCUMENTATION_EMBEDDINGS_TABLE} ORDER BY chunk_id COLLATE BINARY ASC`,
    )
    .all();
  if (!Array.isArray(rawRows)) {
    throw new Error('SQLite did not return an embedding row list');
  }
  const vectors: DocumentationEmbeddingVector[] = [];
  for (const rawRow of rawRows as unknown[]) {
    if (!isRecord(rawRow) || typeof rawRow.chunkId !== 'string') {
      throw new Error('SQLite contains an invalid embedding row');
    }
    vectors.push({
      chunkId: rawRow.chunkId,
      vector: decodeFloat32Blob(rawRow.embedding, rawRow.chunkId),
    });
  }
  return vectors;
}

function validateVector(
  vector: unknown,
  chunkId: string,
): asserts vector is Float32Array {
  if (!(vector instanceof Float32Array) || vector.length !== 1024) {
    throw new Error(
      `Embedding for ${chunkId} must be a 1024-dimensional Float32Array`,
    );
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding for ${chunkId} contains a non-finite value`);
    }
    squaredNorm += value * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > NORMALIZED_VECTOR_TOLERANCE) {
    throw new Error(`Embedding for ${chunkId} is not L2-normalized`);
  }
}

function validateFloat32Blob(value: unknown, chunkId: string): void {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== EMBEDDING_BLOB_BYTES
  ) {
    throw new Error(
      `Embedding BLOB for ${chunkId} must contain exactly ${EMBEDDING_BLOB_BYTES} bytes`,
    );
  }
  let squaredNorm = 0;
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  for (let offset = 0; offset < value.byteLength; offset += 4) {
    const number = bytes.readFloatLE(offset);
    if (!Number.isFinite(number)) {
      throw new Error(
        `Embedding BLOB for ${chunkId} contains a non-finite value`,
      );
    }
    squaredNorm += number * number;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > NORMALIZED_VECTOR_TOLERANCE) {
    throw new Error(`Embedding BLOB for ${chunkId} is not L2-normalized`);
  }
}

function decodeFloat32Blob(value: unknown, chunkId: string): Float32Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== EMBEDDING_BLOB_BYTES
  ) {
    throw new Error(
      `Embedding BLOB for ${chunkId} must contain exactly ${EMBEDDING_BLOB_BYTES} bytes`,
    );
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const vector = new Float32Array(1024);
  for (let offset = 0; offset < value.byteLength; offset += 4) {
    vector[offset / 4] = bytes.readFloatLE(offset);
  }
  return vector;
}

function encodeFloat32Vector(vector: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(EMBEDDING_BLOB_BYTES);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined) {
      throw new Error('Embedding vector data is incomplete');
    }
    bytes.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return bytes;
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
