import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DocumentationCorpusSchema } from '../../../domain/documentation.schemas.js';
import type {
  DocumentationCorpus,
  DocumentationLinkReference,
  DocumentationVersion,
} from '../../../domain/documentation.types.js';
import type { DocumentationEmbeddingSpace } from '../../../domain/documentation-embedding.schemas.js';
import { validateRuntimeIndex } from '../runtime-index.js';
import { DOCUMENTATION_REFERENCES_TABLE } from '../index-schema.js';

interface ExpectedRow {
  chunkId: string;
  chunkIndex: number;
  documentId: string;
  title: string;
  headingPath: string;
  markdown: string;
  canonicalUrl: string;
  sourceRevision: string;
}

/** Check SQLite and FTS5 without writing to the source database. */
export function validateIndexIntegrity(
  database: DatabaseSync,
  version: DocumentationVersion,
  embeddingSpace?: DocumentationEmbeddingSpace,
  canonicalChunkIds?: ReadonlySet<string>,
): ReturnType<typeof validateRuntimeIndex> {
  const summary = validateRuntimeIndex(
    database,
    version,
    embeddingSpace,
    canonicalChunkIds,
  );
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`Documentation v${version} SQLite integrity check failed`);
  }

  // FTS5's integrity check is a write command. Run it on a disposable copy,
  // so validation cannot modify the index consumed by the runtime.
  const directory = mkdtempSync(join(tmpdir(), 'documentation-fts-check-'));
  try {
    const copyPath = join(directory, 'index.sqlite');
    database.prepare('VACUUM main INTO ?').run(copyPath);
    const copy = new DatabaseSync(copyPath);
    try {
      copy
        .prepare(
          "INSERT INTO documentation_search(documentation_search, rank) VALUES ('integrity-check', 1)",
        )
        .run();
    } catch (error) {
      throw new Error(`Documentation v${version} FTS5 integrity check failed`, {
        cause: error,
      });
    } finally {
      copy.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return summary;
}

/** Validate a generated corpus against its existing index. */
export function validateDocumentationIndex(
  version: DocumentationVersion,
  corpus: DocumentationCorpus,
  databasePath: string,
  embeddingSpace?: DocumentationEmbeddingSpace,
): { documentCount: number; chunkCount: number } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const canonicalChunkIds = new Set(
      corpus.documents.flatMap((document) =>
        document.chunks.map((chunk) => chunk.id),
      ),
    );
    validateIndexIntegrity(
      database,
      version,
      embeddingSpace,
      canonicalChunkIds,
    );
    return validateCorpusIndex(version, corpus, database);
  } finally {
    database.close();
  }
}

/** Validate corpus hashes and exact correspondence with its SQLite FTS rows. */
export function validateCorpusIndex(
  version: DocumentationVersion,
  corpus: DocumentationCorpus,
  database: DatabaseSync,
): { documentCount: number; chunkCount: number } {
  const parsedCorpus = DocumentationCorpusSchema.safeParse(corpus);
  if (!parsedCorpus.success || parsedCorpus.data.version !== version) {
    throw new Error(`Documentation v${version} corpus metadata is invalid`);
  }
  const validatedCorpus = parsedCorpus.data;
  const revision = validatedCorpus.source.revision;
  const documents = [...validatedCorpus.documents].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const documentIds = new Set<string>();
  const chunkOwners = new Map<string, string>();
  const expectedRows: ExpectedRow[] = [];

  for (const document of documents) {
    if (
      document.version !== version ||
      documentIds.has(document.id) ||
      document.contentHash !== sha256(document.markdown) ||
      !isSha256(document.source.contentHash) ||
      document.source.provenance.revision !== revision ||
      document.chunks.length === 0
    ) {
      throw new Error(
        `Documentation v${version} document failed integrity checks`,
      );
    }
    documentIds.add(document.id);

    const chunks = [...document.chunks].sort(
      (left, right) =>
        left.index - right.index || compareStrings(left.id, right.id),
    );
    if (chunks.some((chunk, index) => chunk.index !== index)) {
      throw new Error(
        `Documentation chunks for "${document.id}" have invalid ordering`,
      );
    }
    for (const chunk of chunks) {
      if (
        chunk.documentId !== document.id ||
        chunk.title !== document.title ||
        chunk.sourceRevision !== revision ||
        chunk.contentHash !== sha256(chunk.markdown)
      ) {
        throw new Error(
          `Documentation v${version} chunk failed integrity checks`,
        );
      }
      expectedRows.push({
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        documentId: document.id,
        title: document.title,
        headingPath: chunk.headingPath
          .map((heading) => heading.title)
          .join(' > '),
        markdown: chunk.markdown,
        canonicalUrl: chunk.canonicalUrl,
        sourceRevision: revision,
      });
      chunkOwners.set(chunk.id, document.id);
    }
  }

  const actualRows = database
    .prepare(
      `SELECT chunk_id AS chunkId, chunk_index AS chunkIndex,
          document_id AS documentId, title,
          heading_path AS headingPath, markdown,
          canonical_url AS canonicalUrl, source_revision AS sourceRevision
        FROM documentation_search
        WHERE documentation_version = ?
        ORDER BY document_id COLLATE BINARY ASC,
          chunk_index ASC, chunk_id COLLATE BINARY ASC`,
    )
    .all(version);
  if (actualRows.length !== expectedRows.length) {
    throw new Error(
      `Documentation v${version} SQLite row count does not match corpus`,
    );
  }

  for (const [index, row] of actualRows.entries()) {
    const expected = expectedRows[index];
    if (
      !expected ||
      row.chunkId !== expected.chunkId ||
      row.chunkIndex !== expected.chunkIndex ||
      row.documentId !== expected.documentId ||
      row.title !== expected.title ||
      row.headingPath !== expected.headingPath ||
      row.markdown !== expected.markdown ||
      row.canonicalUrl !== expected.canonicalUrl ||
      row.sourceRevision !== expected.sourceRevision
    ) {
      throw new Error(
        `Documentation v${version} SQLite content does not match corpus`,
      );
    }
  }

  validateCorpusReferences(validatedCorpus, database, documentIds, chunkOwners);

  return { documentCount: documentIds.size, chunkCount: expectedRows.length };
}

function validateCorpusReferences(
  corpus: DocumentationCorpus,
  database: DatabaseSync,
  documentIds: ReadonlySet<string>,
  chunkOwners: ReadonlyMap<string, string>,
): void {
  const expected: Array<{
    chunkId: string;
    occurrenceIndex: number;
    reference: DocumentationLinkReference;
  }> = [];
  for (const document of corpus.documents) {
    for (const chunk of document.chunks) {
      for (const [occurrenceIndex, reference] of chunk.references.entries()) {
        if (reference.endOffset > chunk.markdown.length) {
          throw new Error('Documentation link occurrence exceeds its chunk');
        }
        if (!documentIds.has(reference.documentId)) {
          throw new Error(
            'Documentation link target is missing from its corpus',
          );
        }
        if (
          reference.sectionId &&
          chunkOwners.get(reference.sectionId) !== reference.documentId
        ) {
          throw new Error('Documentation link section target is invalid');
        }
        expected.push({ chunkId: chunk.id, occurrenceIndex, reference });
      }
    }
  }
  expected.sort(
    (left, right) =>
      compareStrings(left.chunkId, right.chunkId) ||
      left.occurrenceIndex - right.occurrenceIndex,
  );
  const actual = database
    .prepare(
      `SELECT chunk_id AS chunkId, occurrence_index AS occurrenceIndex,
          href, start_offset AS startOffset, end_offset AS endOffset,
          target_document_id AS documentId, target_section_id AS sectionId
        FROM ${DOCUMENTATION_REFERENCES_TABLE}
        ORDER BY chunk_id COLLATE BINARY ASC, occurrence_index ASC`,
    )
    .all();
  if (actual.length !== expected.length) {
    throw new Error(
      'SQLite link references do not match the documentation corpus',
    );
  }
  for (const [index, row] of actual.entries()) {
    const expectedReference = expected[index];
    const reference = expectedReference?.reference;
    if (
      !expectedReference ||
      !reference ||
      row.chunkId !== expectedReference.chunkId ||
      row.occurrenceIndex !== expectedReference.occurrenceIndex ||
      row.href !== reference.href ||
      row.startOffset !== reference.startOffset ||
      row.endOffset !== reference.endOffset ||
      row.documentId !== reference.documentId ||
      (row.sectionId ?? undefined) !== reference.sectionId
    ) {
      throw new Error(
        'SQLite link references do not match the documentation corpus',
      );
    }
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
