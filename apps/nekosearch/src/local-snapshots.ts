import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  addSnapshot,
  getCatalogIndex,
  validateSnapshotDirectory,
  type CatalogOptions,
  type DocumentationCatalogEntry,
} from './catalog.js';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';

export type LocalDocumentationSnapshotBuilder = (
  inputDirectory: string,
  selector: string,
  outputDirectory: string,
  embeddingProvider?: DocumentationEmbeddingProvider,
) => Promise<unknown>;

export interface LocalSnapshotInstallOptions extends CatalogOptions {
  /** Injectable builder for deterministic offline tests. */
  builder?: LocalDocumentationSnapshotBuilder;
  embeddingProvider?: DocumentationEmbeddingProvider;
}

/** Build, validate, and install a local Markdown/MDX directory offline. */
export async function installLocalSnapshot(
  inputDirectory: string,
  selector: string,
  options: LocalSnapshotInstallOptions = {},
): Promise<DocumentationCatalogEntry> {
  const resolvedInputDirectory = resolve(inputDirectory);
  await assertSafeInputDirectory(resolvedInputDirectory);
  const { builder, embeddingProvider, ...catalogOptions } = options;

  // Avoid doing an expensive build when the selector already exists. The
  // installer repeats this precondition under the catalog lock.
  if (await getCatalogIndex(selector, catalogOptions)) {
    throw new Error(`Catalog already contains ${selector}`);
  }

  const stagingDirectory = await mkdtemp(
    join(tmpdir(), 'nekosearch-local-snapshot-'),
  );
  try {
    await (builder ?? buildWithLocalIndexer)(
      resolvedInputDirectory,
      selector,
      stagingDirectory,
      embeddingProvider,
    );
    const snapshot = await validateSnapshotDirectory(stagingDirectory);
    const { source, version } = parseSelector(selector);
    if (
      snapshot.source !== source ||
      snapshot.version !== version ||
      snapshot.manifest.documentation.id !== source
    ) {
      throw new Error(
        `Built snapshot does not match the requested selector ${selector}`,
      );
    }
    return await addSnapshot(stagingDirectory, catalogOptions);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function buildWithLocalIndexer(
  inputDirectory: string,
  selector: string,
  outputDirectory: string,
  embeddingProvider?: DocumentationEmbeddingProvider,
): Promise<unknown> {
  const { buildLocalSnapshot } = await import('./build.js');
  return buildLocalSnapshot(
    [inputDirectory, '--id', selector, '--output', outputDirectory, '--clean'],
    { embeddingProvider },
  );
}

async function assertSafeInputDirectory(directory: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (cause) {
    throw new Error(
      `Unable to inspect documentation directory "${directory}"`,
      {
        cause,
      },
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Documentation input must be a real directory, not a symbolic link or file: "${directory}"`,
    );
  }
}

function parseSelector(selector: string): { source: string; version: string } {
  const separator = selector.lastIndexOf('@');
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(
      `Invalid source selector "${selector}"; use the form source@version`,
    );
  }
  return {
    source: selector.slice(0, separator),
    version: selector.slice(separator + 1),
  };
}
