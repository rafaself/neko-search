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

export type OutdatedStatus =
  'current' | 'changed' | 'untracked' | 'check failed';

export interface OutdatedSnapshotResult {
  selector: string;
  source: string;
  version: string;
  status: OutdatedStatus;
  installedRevision: string;
  upstreamRevision?: string;
  error?: string;
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

  const fetcher = options.fetcher ?? fetch;
  const sourceBuilder = options.sourceBuilder ?? (await loadSourceBuilder());
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
          : `${source}@${version}`,
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
      const entry = await addSnapshot(snapshotDirectory, options, {
        trackingRecipe: isImmutableRef(resolvedSource.ref)
          ? null
          : `${source}@${version}`,
      });
      return { entry, changed: true };
    }
    return await updateSnapshot(snapshotDirectory, options, {
      trackingRecipe: isImmutableRef(resolvedSource.ref)
        ? null
        : `${source}@${version}`,
      ...(current ? { expectedCurrent: snapshotIdentity(current) } : {}),
    });
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

/** Resolve refs without downloading any documentation files. */
export async function checkOutdatedSnapshots(
  selector?: string,
  options: RemoteSnapshotOptions = {},
): Promise<OutdatedSnapshotResult[]> {
  const entries = (await listCatalogIndexes(options)).filter(
    (entry) => entry.status === 'installed',
  );
  let targets: DocumentationCatalogEntry[];
  if (selector !== undefined) {
    const parsed = parseSelector(selector);
    const entry = entries.find(
      (candidate) =>
        candidate.source === parsed.source &&
        candidate.version === parsed.version,
    );
    if (!entry) {
      throw new Error(
        `No installed snapshot exists for ${selector}; run "nekosearch list" to see installed sources`,
      );
    }
    targets = [entry];
  } else {
    targets = entries.filter(
      (entry) =>
        entry.trackingRecipe !== undefined &&
        !(
          entry.manifest.source.kind === 'git' &&
          isImmutableRef(entry.manifest.source.ref)
        ),
    );
  }

  if (targets.length === 0) return [];
  const fetcher = options.fetcher ?? fetch;
  const sourceBuilder = options.sourceBuilder ?? (await loadSourceBuilder());
  const results: OutdatedSnapshotResult[] = [];
  for (const entry of targets) {
    const canonicalSelector = `${entry.source}@${entry.version}`;
    if (
      entry.trackingRecipe !== canonicalSelector ||
      entry.manifest.source.kind !== 'git' ||
      isImmutableRef(entry.manifest.source.ref)
    ) {
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
