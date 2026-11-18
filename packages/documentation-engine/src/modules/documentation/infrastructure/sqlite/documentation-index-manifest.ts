import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DocumentationBuildManifestSchema,
  DocumentationIndexRuntimeManifestSchema,
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  type DocumentationIndexRuntimeManifest,
} from '../../domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from './index-schema.js';

/** Load and validate the manifest that describes one existing SQLite index. */
export function loadDocumentationIndexManifest(
  databasePath: string,
  manifestPath = join(dirname(resolve(databasePath)), 'manifest.json'),
): DocumentationIndexRuntimeManifest {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read documentation index manifest "${manifestPath}"`,
      { cause: error },
    );
  }

  let buildManifest: ReturnType<typeof DocumentationBuildManifestSchema.parse>;
  try {
    buildManifest = DocumentationBuildManifestSchema.parse(parsedJson);
  } catch (error) {
    throw new Error('Invalid documentation build manifest', { cause: error });
  }
  const manifest = DocumentationIndexRuntimeManifestSchema.parse({
    manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
    documentation: buildManifest.documentation,
    source: buildManifest.source,
    index: buildManifest.index,
    ...(buildManifest.embeddings && { embeddings: buildManifest.embeddings }),
  });

  if (manifest.index.file !== basename(resolve(databasePath))) {
    throw new Error(
      'Documentation index manifest names a different database file',
    );
  }
  if (
    manifest.index.schemaVersion !== DOCUMENTATION_INDEX_SCHEMA_VERSION ||
    manifest.index.formatVersion !== DOCUMENTATION_INDEX_FORMAT_VERSION
  ) {
    throw new Error('Documentation index manifest format is unsupported');
  }
  return manifest;
}
