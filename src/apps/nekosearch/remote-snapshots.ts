import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GitDocumentationSource } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  addSnapshot,
  listCatalogIndexes,
  updateSnapshot,
  validateSnapshotDirectory,
  type CatalogOptions,
  type SnapshotUpdateResult,
} from './catalog.js';

const OFFICIAL_SOURCE_REPOSITORY = 'https://github.com/nestjs/docs.nestjs.com';
const SUPPORTED_VERSIONS = ['11', '12'] as const;

type NestJsVersion = (typeof SUPPORTED_VERSIONS)[number];
type RemoteOperation = 'add' | 'update';

export interface NestJsSnapshotBuilder {
  resolveDocumentationSource(
    version: NestJsVersion,
    fetcher: typeof fetch,
  ): Promise<GitDocumentationSource>;
  buildNestJsDocumentationSnapshot(
    version: NestJsVersion,
    outputDirectory: string,
    fetcher: typeof fetch,
    resolvedSource: GitDocumentationSource,
  ): Promise<unknown>;
}

export interface RemoteSnapshotOptions extends CatalogOptions {
  /** Injectable HTTPS transport and builder for deterministic offline tests. */
  fetcher?: typeof fetch;
  sourceBuilder?: NestJsSnapshotBuilder;
}

export type RemoteSnapshotResult = SnapshotUpdateResult;

/** Resolve a curated upstream ref, build locally, validate, then activate. */
export async function installRemoteSnapshot(
  source: string,
  version: string,
  operation: RemoteOperation,
  options: RemoteSnapshotOptions = {},
): Promise<RemoteSnapshotResult> {
  const targetVersion = parseTarget(source, version);
  const currentEntries = await listCatalogIndexes(options);
  const current = currentEntries.find(
    (entry) =>
      entry.source === source &&
      entry.version === version &&
      entry.status === 'installed',
  );
  if (operation === 'add' && current) {
    throw new Error(`Catalog already contains ${source}@${version}`);
  }
  if (operation === 'update' && !current) {
    throw new Error(`No installed snapshot exists for ${source}@${version}`);
  }

  const fetcher = options.fetcher ?? fetch;
  const sourceBuilder = options.sourceBuilder ?? (await loadSourceBuilder());
  const resolvedSource = await sourceBuilder.resolveDocumentationSource(
    targetVersion,
    fetcher,
  );
  if (
    resolvedSource.repository !== OFFICIAL_SOURCE_REPOSITORY ||
    !/^[a-f0-9]{40}$/u.test(resolvedSource.revision)
  ) {
    throw new Error('Resolved source does not match the curated NestJS recipe');
  }
  if (
    operation === 'update' &&
    current?.revision === resolvedSource.revision &&
    current.manifest.source.kind === 'git' &&
    current.manifest.source.ref === resolvedSource.ref
  ) {
    return { entry: current, changed: false };
  }

  const snapshotDirectory = await mkdtemp(
    join(tmpdir(), 'nekosearch-source-snapshot-'),
  );
  try {
    await sourceBuilder.buildNestJsDocumentationSnapshot(
      targetVersion,
      snapshotDirectory,
      fetcher,
      resolvedSource,
    );
    const snapshot = await validateSnapshotDirectory(snapshotDirectory);
    if (
      snapshot.source !== source ||
      snapshot.version !== version ||
      snapshot.revision !== resolvedSource.revision ||
      snapshot.manifest.documentation.id !== source ||
      snapshot.manifest.source.kind !== 'git' ||
      snapshot.manifest.source.repository !== OFFICIAL_SOURCE_REPOSITORY ||
      snapshot.manifest.source.ref !== resolvedSource.ref
    ) {
      throw new Error(
        'Built snapshot does not match the requested curated NestJS source',
      );
    }

    if (operation === 'add') {
      const entry = await addSnapshot(snapshotDirectory, options);
      return { entry, changed: true };
    }
    return await updateSnapshot(snapshotDirectory, options);
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

function parseTarget(source: string, version: string): NestJsVersion {
  if (
    source !== 'nestjs' ||
    !SUPPORTED_VERSIONS.includes(version as NestJsVersion)
  ) {
    throw new Error(
      `Curated source recipes support only nestjs@${SUPPORTED_VERSIONS.join(' and nestjs@')}`,
    );
  }
  return version as NestJsVersion;
}

async function loadSourceBuilder(): Promise<NestJsSnapshotBuilder> {
  const modulePath = join(
    dirname(fileURLToPath(import.meta.url)),
    'build-runtime/integrations/nestjs/documentation.integration.js',
  );
  return (await import(
    pathToFileURL(modulePath).href
  )) as NestJsSnapshotBuilder;
}
