import type { DocumentationVersion } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DatabaseSync } from 'node:sqlite';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import {
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationIndexRuntimeManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { validateRuntimeIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/runtime-index.js';
import { basename } from 'node:path';

/** Test-only convenience for direct calls against a validated SQLite index. */
export class TestDocumentationSearchService extends DocumentationSearchService {
  private readonly sqliteStore: SQLiteDocumentationStore;
  readonly database: DatabaseSync;

  constructor(databasePath: string, version: DocumentationVersion) {
    const initial = new DatabaseSync(databasePath, { readOnly: true });
    let summary: ReturnType<typeof validateRuntimeIndex>;
    try {
      summary = validateRuntimeIndex(initial, version);
    } finally {
      initial.close();
    }
    const manifest = DocumentationIndexRuntimeManifestSchema.parse({
      manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
      documentation: { id: `test-documentation-${version}`, version },
      source: {
        kind: 'local',
        root: '/test/documentation',
        revision: summary.revision,
      },
      index: {
        file: basename(databasePath),
        sha256: '0'.repeat(64),
        documentationVersion: version,
        sourceRevision: summary.revision,
        schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
        formatVersion: summary.indexFormatVersion,
        documentCount: summary.documentCount,
        chunkCount: summary.chunkCount,
      },
    });
    const store = new SQLiteDocumentationStore(databasePath, manifest);
    super(store, manifest);
    this.sqliteStore = store;
    this.database = (store as unknown as { database: DatabaseSync }).database;
  }

  close(): void {
    this.sqliteStore.close();
  }
}
