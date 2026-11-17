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
  type DocumentationCatalogEntry,
  type SnapshotIdentity,
  type SnapshotUpdateResult,
} from './catalog.js';

const OFFICIAL_SOURCE_REPOSITORY = 'https://github.com/nestjs/docs.nestjs.com';
const SUPPORTED_VERSIONS = ['11', '12'] as const;

export const CURATED_REMOTE_SNAPSHOT_RECIPES = SUPPORTED_VERSIONS.map(
  (version) => ({ source: 'nestjs', version, selector: `nestjs@${version}` }),
);

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
    onProgress?: (phase: 'downloading' | 'indexing') => void,
  ): Promise<unknown>;
}

export interface RemoteSnapshotOptions extends CatalogOptions {
  /** Injectable HTTPS transport and builder for deterministic offline tests. */
  fetcher?: typeof fetch;
  sourceBuilder?: NestJsSnapshotBuilder;
  onProgress?: (phase: RemoteSnapshotPhase) => void;
}

export type RemoteSnapshotPhase =
  'resolving' | 'downloading' | 'indexing' | 'validating' | 'installing';

export type RemoteSnapshotResult = SnapshotUpdateResult;

export type UpstreamRevisionStatus =
  'current' | 'changed' | 'untracked' | 'check failed';

export interface UpstreamRevisionResult {
  selector: string;
  source: string;
  version: string;
  status: UpstreamRevisionStatus;
  installedRevision: string;
  upstreamRevision?: string;
  error?: string;
}

export type SnapshotTrackingState =
  'tracked' | 'untracked' | 'pinned' | 'not applicable';

export function getSnapshotTrackingState(
  entry: DocumentationCatalogEntry,
): SnapshotTrackingState {
  if (entry.status === 'bundled') return 'not applicable';
  if (
    entry.manifest.source.kind === 'git' &&
    entry.manifest.source.directory !== undefined
  ) {
    return 'untracked';
  }
  if (
    entry.manifest.source.kind === 'git' &&
    isImmutableRef(entry.manifest.source.ref)
  ) {
    return 'pinned';
  }
  return entry.trackingRecipe === `${entry.source}@${entry.version}` &&
    entry.manifest.source.kind === 'git'
    ? 'tracked'
    : 'untracked';
}

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
  const recipeSelector = `${source}@${version}`;
  if (operation === 'update' && current?.trackingRecipe !== recipeSelector) {
    throw new Error(
      `Installed snapshot ${recipeSelector} is not linked to its matching curated recipe; only snapshots installed by the curated add command can be updated`,
    );
  }

  const fetcher = options.fetcher ?? fetch;
  const sourceBuilder = options.sourceBuilder ?? (await loadSourceBuilder());
  options.onProgress?.('resolving');
  const resolvedSource = await resolveRecipe(
    targetVersion,
    sourceBuilder,
    fetcher,
  );
  if (
    operation === 'update' &&
    current?.revision === resolvedSource.revision &&
    current.manifest.source.kind === 'git' &&
    current.manifest.source.repository === OFFICIAL_SOURCE_REPOSITORY
  ) {
    const updated = await updateSnapshot(
      dirname(current.databasePath),
      options,
      {
        trackingRecipe: isImmutableRef(resolvedSource.ref)
          ? null
          : recipeSelector,
        expectedTrackingRecipe: recipeSelector,
        expectedCurrent: snapshotIdentity(current),
      },
    );
    return { ...updated, changed: false };
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
      options.onProgress,
    );
    options.onProgress?.('validating');
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
      options.onProgress?.('installing');
      const entry = await addSnapshot(snapshotDirectory, options, {
        trackingRecipe: isImmutableRef(resolvedSource.ref)
          ? null
          : `${source}@${version}`,
      });
      return { entry, changed: true };
    }
    options.onProgress?.('installing');
    return await updateSnapshot(snapshotDirectory, options, {
      trackingRecipe: isImmutableRef(resolvedSource.ref)
        ? null
        : recipeSelector,
      ...(operation === 'update'
        ? { expectedTrackingRecipe: recipeSelector }
        : {}),
      ...(current ? { expectedCurrent: snapshotIdentity(current) } : {}),
    });
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

/** Check only the supplied installed snapshots and never download documentation. */
export async function checkUpstreamRevisions(
  entries: readonly DocumentationCatalogEntry[],
  options: RemoteSnapshotOptions = {},
): Promise<UpstreamRevisionResult[]> {
  const targets = entries.filter((entry) => entry.status === 'installed');
  const fetcher = options.fetcher ?? fetch;
  let sourceBuilderPromise: Promise<NestJsSnapshotBuilder> | undefined;
  const results: UpstreamRevisionResult[] = [];
  for (const entry of targets) {
    const canonicalSelector = `${entry.source}@${entry.version}`;
    if (getSnapshotTrackingState(entry) !== 'tracked') {
      results.push({
        selector: canonicalSelector,
        source: entry.source,
        version: entry.version,
        status: 'untracked',
        installedRevision: entry.revision,
      });
      continue;
    }
    try {
      sourceBuilderPromise ??= options.sourceBuilder
        ? Promise.resolve(options.sourceBuilder)
        : loadSourceBuilder();
      const sourceBuilder = await sourceBuilderPromise;
      const targetVersion = parseTarget(entry.source, entry.version);
      const upstream = await resolveRecipe(
        targetVersion,
        sourceBuilder,
        fetcher,
      );
      results.push({
        selector: canonicalSelector,
        source: entry.source,
        version: entry.version,
        status: upstream.revision === entry.revision ? 'current' : 'changed',
        installedRevision: entry.revision,
        upstreamRevision: upstream.revision,
      });
    } catch (error) {
      results.push({
        selector: canonicalSelector,
        source: entry.source,
        version: entry.version,
        status: 'check failed',
        installedRevision: entry.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function resolveRecipe(
  version: NestJsVersion,
  sourceBuilder: NestJsSnapshotBuilder,
  fetcher: typeof fetch,
): Promise<GitDocumentationSource> {
  const resolvedSource = await sourceBuilder.resolveDocumentationSource(
    version,
    fetcher,
  );
  if (
    resolvedSource.repository !== OFFICIAL_SOURCE_REPOSITORY ||
    !/^[a-f0-9]{40}$/u.test(resolvedSource.revision)
  ) {
    throw new Error('Resolved source does not match the curated NestJS recipe');
  }
  return resolvedSource;
}

function isImmutableRef(ref: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(ref);
}

function snapshotIdentity(entry: DocumentationCatalogEntry): SnapshotIdentity {
  return {
    source: entry.source,
    version: entry.version,
    revision: entry.revision,
    directoryKey: entry.databasePath.split(/[\\/]/u).at(-2) ?? '',
  };
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
