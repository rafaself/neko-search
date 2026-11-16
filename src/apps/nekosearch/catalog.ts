import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import {
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationBuildManifestSchema,
  DocumentationIndexRuntimeManifestSchema,
  type DocumentationIndexRuntimeManifest,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { validateRuntimeIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/runtime-index.js';

const SNAPSHOT_FILES = [
  'corpus.json',
  'index.sqlite',
  'manifest.json',
] as const;
const BUNDLED_NEST_VERSIONS = ['11', '12'] as const;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CORPUS_BYTES = 512 * 1024 * 1024;
const MAX_INDEX_BYTES = 512 * 1024 * 1024;
const CATALOG_DIRECTORY_NAME = 'nekosearch';
const SNAPSHOTS_DIRECTORY_NAME = 'snapshots';
const CATALOG_FILE_NAME = 'catalog.json';
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export type CatalogEntryStatus = 'bundled' | 'installed';

export interface DocumentationCatalogEntry {
  source: string;
  version: string;
  revision: string;
  status: CatalogEntryStatus;
  databasePath: string;
  manifest: DocumentationIndexRuntimeManifest;
}

interface SnapshotFiles {
  corpus: Buffer;
  database: Buffer;
  manifest: Buffer;
}

interface ValidatedSnapshot {
  source: string;
  version: string;
  revision: string;
  databasePath: string;
  manifest: DocumentationIndexRuntimeManifest;
  files: SnapshotFiles;
}

interface CatalogSnapshotPointer {
  source: string;
  version: string;
  revision: string;
  directoryKey: string;
}

interface CatalogRegistry {
  formatVersion: 1;
  snapshots: CatalogSnapshotPointer[];
}

export interface SnapshotUpdateResult {
  entry: DocumentationCatalogEntry;
  changed: boolean;
}

export interface CatalogOptions {
  catalogRoot?: string;
  packageDataDirectory?: string;
}

/** Read the complete catalog and validate every installed snapshot. */
export async function listCatalogIndexes(
  options: CatalogOptions = {},
): Promise<DocumentationCatalogEntry[]> {
  const packageDataDirectory =
    options.packageDataDirectory ?? getPackageDataDirectory();
  const catalogRoot = options.catalogRoot ?? getUserCatalogDirectory();
  const entries = [
    ...(await loadBundledProtocolSnapshot(packageDataDirectory)),
    ...(await loadBundledNestIndexes(packageDataDirectory)),
    ...(await loadInstalledSnapshots(catalogRoot)),
  ];
  entries.sort(
    (left, right) =>
      compareStrings(left.source, right.source) ||
      compareStrings(left.version, right.version) ||
      compareStrings(left.status, right.status),
  );
  assertUniqueCatalogIdentities(entries);
  return entries;
}

/** Validate the snapshot fully before creating or changing the user catalog. */
export async function addSnapshot(
  snapshotDirectory: string,
  options: CatalogOptions = {},
): Promise<DocumentationCatalogEntry> {
  const snapshot = await validateSnapshotDirectory(snapshotDirectory);
  const existingEntries = await listCatalogIndexes(options);
  if (
    existingEntries.some(
      (entry) =>
        entry.source === snapshot.source && entry.version === snapshot.version,
    )
  ) {
    throw new Error(
      `Catalog already contains ${snapshot.source}@${snapshot.version}`,
    );
  }

  await activateSnapshot(snapshot, options, existingEntries);
  return catalogEntry(
    { ...snapshot, databasePath: installedDatabasePath(snapshot, options) },
    'installed',
  );
}

/** Replace the installed revision only after the new snapshot validates. */
export async function updateSnapshot(
  snapshotDirectory: string,
  options: CatalogOptions = {},
): Promise<SnapshotUpdateResult> {
  const snapshot = await validateSnapshotDirectory(snapshotDirectory);
  const existingEntries = await listCatalogIndexes(options);
  const current = existingEntries.find(
    (entry) =>
      entry.status === 'installed' &&
      entry.source === snapshot.source &&
      entry.version === snapshot.version,
  );
  if (!current) {
    throw new Error(
      `No installed snapshot exists for ${snapshot.source}@${snapshot.version}`,
    );
  }
  if (
    current.revision === snapshot.revision &&
    current.manifest.index.sha256 === snapshot.manifest.index.sha256
  ) {
    return { entry: current, changed: false };
  }

  await activateSnapshot(snapshot, options, existingEntries);
  return {
    entry: catalogEntry(
      { ...snapshot, databasePath: installedDatabasePath(snapshot, options) },
      'installed',
    ),
    changed: true,
  };
}

async function activateSnapshot(
  snapshot: ValidatedSnapshot,
  options: CatalogOptions,
  existingEntries: DocumentationCatalogEntry[],
): Promise<void> {
  const catalogRoot = options.catalogRoot ?? getUserCatalogDirectory();

  const snapshotsDirectory = join(catalogRoot, SNAPSHOTS_DIRECTORY_NAME);
  await assertDirectoryIfPresent(catalogRoot, 'Catalog directory');
  await assertDirectoryIfPresent(snapshotsDirectory, 'Snapshots directory');

  const directoryKey = snapshotStorageKey(snapshot);
  const targetDirectory = join(snapshotsDirectory, directoryKey);

  await mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(snapshotsDirectory, 'Snapshots directory');
  if (await pathExists(targetDirectory)) {
    await assertRealDirectory(targetDirectory, 'Installed snapshot directory');
    const existingSnapshot = await validateSnapshotDirectory(targetDirectory);
    if (
      existingSnapshot.source !== snapshot.source ||
      existingSnapshot.version !== snapshot.version ||
      existingSnapshot.revision !== snapshot.revision ||
      existingSnapshot.manifest.index.sha256 !== snapshot.manifest.index.sha256
    ) {
      throw new Error('Snapshot storage key points to different contents');
    }
  } else {
    const stagingDirectory = await mkdtemp(
      join(snapshotsDirectory, '.pending-'),
    );
    try {
      await writeFile(
        join(stagingDirectory, 'corpus.json'),
        snapshot.files.corpus,
        { flag: 'wx', mode: 0o600 },
      );
      await writeFile(
        join(stagingDirectory, 'index.sqlite'),
        snapshot.files.database,
        { flag: 'wx', mode: 0o600 },
      );
      await writeFile(
        join(stagingDirectory, 'manifest.json'),
        snapshot.files.manifest,
        { flag: 'wx', mode: 0o600 },
      );
      const staged = await validateSnapshotDirectory(stagingDirectory);
      if (
        staged.source !== snapshot.source ||
        staged.version !== snapshot.version ||
        staged.revision !== snapshot.revision ||
        staged.manifest.index.sha256 !== snapshot.manifest.index.sha256
      ) {
        throw new Error('Staged snapshot changed during installation');
      }
      await rename(stagingDirectory, targetDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  const snapshots = existingEntries
    .filter(
      (entry) =>
        entry.status === 'installed' &&
        (entry.source !== snapshot.source ||
          entry.version !== snapshot.version),
    )
    .map((entry) => ({
      source: entry.source,
      version: entry.version,
      revision: entry.revision,
      directoryKey: basename(dirname(entry.databasePath)),
    }));
  snapshots.push({
    source: snapshot.source,
    version: snapshot.version,
    revision: snapshot.revision,
    directoryKey,
  });
  snapshots.sort(
    (left, right) =>
      compareStrings(left.source, right.source) ||
      compareStrings(left.version, right.version),
  );
  await writeCatalogRegistry(catalogRoot, {
    formatVersion: 1,
    snapshots,
  });
}

/** Validate the exact three-file snapshot format emitted by the indexer. */
export async function validateSnapshotDirectory(
  snapshotDirectory: string,
): Promise<ValidatedSnapshot> {
  if (!snapshotDirectory.trim()) {
    throw new Error('Snapshot directory path must not be empty');
  }
  const directory = resolve(snapshotDirectory);
  await assertRealDirectory(directory, 'Snapshot directory');

  const names = await readdir(directory);
  if (
    names.length !== SNAPSHOT_FILES.length ||
    names.some(
      (name) =>
        !SNAPSHOT_FILES.includes(name as (typeof SNAPSHOT_FILES)[number]),
    )
  ) {
    throw new Error(
      `Snapshot directory must contain exactly: ${SNAPSHOT_FILES.join(', ')}`,
    );
  }

  const [manifest, corpus, database] = await Promise.all([
    readRegularFile(join(directory, 'manifest.json'), MAX_MANIFEST_BYTES),
    readRegularFile(join(directory, 'corpus.json'), MAX_CORPUS_BYTES),
    readRegularFile(join(directory, 'index.sqlite'), MAX_INDEX_BYTES),
  ]);
  const buildManifest = parseBuildManifest(manifest);
  const parsedCorpus = parseCorpus(corpus);
  assertSnapshotIdentity(buildManifest, parsedCorpus);
  assertSnapshotHashes(buildManifest, corpus, database);
  const runtimeManifest = runtimeManifestFromBuild(buildManifest);
  const databasePath = join(directory, 'index.sqlite');
  validateSnapshotIndex(databasePath, parsedCorpus, buildManifest);

  return {
    source: buildManifest.documentation.id,
    version: buildManifest.documentation.version,
    revision: buildManifest.source.revision,
    databasePath,
    manifest: runtimeManifest,
    files: { manifest, corpus, database },
  };
}

/** Tab-separated output keeps IDs and revisions unambiguous for scripts. */
export function formatCatalogList(
  entries: DocumentationCatalogEntry[],
): string {
  return [
    ['SOURCE', 'VERSION', 'REVISION', 'STATUS'].join('\t'),
    ...entries.map((entry) =>
      [entry.source, entry.version, entry.revision, entry.status].join('\t'),
    ),
  ].join('\n');
}

export function getUserCatalogDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const dataHome =
    process.platform === 'win32'
      ? environment.LOCALAPPDATA?.trim() || homedir()
      : environment.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return resolve(dataHome, CATALOG_DIRECTORY_NAME);
}

async function loadBundledProtocolSnapshot(
  packageDataDirectory: string,
): Promise<DocumentationCatalogEntry[]> {
  const directory = join(packageDataDirectory, 'mcp-protocol');
  const snapshot = await validateSnapshotDirectory(directory);
  return [catalogEntry(snapshot, 'bundled')];
}

async function loadBundledNestIndexes(
  packageDataDirectory: string,
): Promise<DocumentationCatalogEntry[]> {
  const entries: DocumentationCatalogEntry[] = [];
  for (const version of BUNDLED_NEST_VERSIONS) {
    const databasePath = join(
      packageDataDirectory,
      `documentation-v${version}.sqlite`,
    );
    const manifestPath = join(
      packageDataDirectory,
      `documentation-v${version}.manifest.json`,
    );
    const [database, manifestBytes] = await Promise.all([
      readRegularFile(databasePath, MAX_INDEX_BYTES),
      readRegularFile(manifestPath, MAX_MANIFEST_BYTES),
    ]);
    const manifest = parseRuntimeManifest(manifestBytes);
    if (
      manifest.index.file !== basename(databasePath) ||
      manifest.documentation.version !== version ||
      sha256(database) !== manifest.index.sha256
    ) {
      throw new Error(`Bundled documentation v${version} manifest is invalid`);
    }
    validateRuntimeDatabase(databasePath, manifest);
    entries.push({
      source: manifest.documentation.id,
      version: manifest.documentation.version,
      revision: manifest.source.revision,
      status: 'bundled',
      databasePath,
      manifest,
    });
  }
  return entries;
}

async function loadInstalledSnapshots(
  catalogRoot: string,
): Promise<DocumentationCatalogEntry[]> {
  const snapshotsDirectory = join(catalogRoot, SNAPSHOTS_DIRECTORY_NAME);
  if (await pathExists(catalogRoot)) {
    await assertRealDirectory(catalogRoot, 'Catalog directory');
  }
  const registryPath = join(catalogRoot, CATALOG_FILE_NAME);
  if (await pathExists(registryPath)) {
    const registryBytes = await readRegularFile(
      registryPath,
      MAX_CATALOG_BYTES,
    );
    const registry = parseCatalogRegistry(registryBytes);
    if (registry.snapshots.length === 0) return [];
    if (!(await pathExists(snapshotsDirectory))) {
      throw new Error('Catalog snapshots directory is missing');
    }
    await assertRealDirectory(snapshotsDirectory, 'Snapshots directory');

    const entries: DocumentationCatalogEntry[] = [];
    for (const pointer of registry.snapshots) {
      const directory = join(snapshotsDirectory, pointer.directoryKey);
      await assertRealDirectory(directory, 'Installed snapshot directory');
      const snapshot = await validateSnapshotDirectory(directory);
      if (
        snapshot.source !== pointer.source ||
        snapshot.version !== pointer.version ||
        snapshot.revision !== pointer.revision ||
        !isValidSnapshotStorageKey(pointer.directoryKey, snapshot)
      ) {
        throw new Error('Catalog snapshot pointer identity is invalid');
      }
      entries.push(catalogEntry(snapshot, 'installed'));
    }
    assertUniqueInstalledIdentities(entries);
    return entries;
  }

  if (!(await pathExists(snapshotsDirectory))) return [];
  await assertRealDirectory(snapshotsDirectory, 'Snapshots directory');

  const entries: DocumentationCatalogEntry[] = [];
  for (const name of (await readdir(snapshotsDirectory)).sort(compareStrings)) {
    if (name.startsWith('.pending-')) continue;
    if (!/^[a-f0-9]{64}$/u.test(name)) {
      throw new Error('Catalog contains an unsafe snapshot directory name');
    }
    const directory = join(snapshotsDirectory, name);
    await assertRealDirectory(directory, 'Installed snapshot directory');
    const snapshot = await validateSnapshotDirectory(directory);
    if (snapshotDirectoryKey(snapshot.source, snapshot.version) !== name) {
      throw new Error('Installed snapshot directory identity is invalid');
    }
    entries.push(catalogEntry(snapshot, 'installed'));
  }
  return entries;
}

function parseCatalogRegistry(bytes: Buffer): CatalogRegistry {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Catalog registry is not valid JSON', { cause });
  }
  if (
    !isRecord(value) ||
    hasOnlyKeys(value, ['formatVersion', 'snapshots']) !== true ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.snapshots)
  ) {
    throw new Error('Catalog registry does not match the supported format');
  }

  const snapshots = value.snapshots.map((candidate): CatalogSnapshotPointer => {
    if (
      !isRecord(candidate) ||
      hasOnlyKeys(candidate, [
        'source',
        'version',
        'revision',
        'directoryKey',
      ]) !== true ||
      typeof candidate.source !== 'string' ||
      typeof candidate.version !== 'string' ||
      typeof candidate.revision !== 'string' ||
      typeof candidate.directoryKey !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.directoryKey)
    ) {
      throw new Error('Catalog registry contains an unsafe snapshot pointer');
    }
    const pointer = {
      source: candidate.source,
      version: candidate.version,
      revision: candidate.revision,
      directoryKey: candidate.directoryKey,
    };
    validateCatalogText(pointer.source, 256, 'Source');
    validateCatalogText(pointer.version, 64, 'Version');
    validateCatalogText(pointer.revision, 256, 'Revision');
    return pointer;
  });
  return { formatVersion: 1, snapshots };
}

async function writeCatalogRegistry(
  catalogRoot: string,
  registry: CatalogRegistry,
): Promise<void> {
  await assertRealDirectory(catalogRoot, 'Catalog directory');
  const registryPath = join(catalogRoot, CATALOG_FILE_NAME);
  if (await pathExists(registryPath)) {
    const info = await lstat(registryPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Catalog registry must be a safe regular file');
    }
  }
  const temporaryPath = join(catalogRoot, `.catalog-${randomUUID()}.pending`);
  const contents = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
  if (contents.byteLength > MAX_CATALOG_BYTES) {
    throw new Error('Catalog registry is too large');
  }

  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, registryPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertUniqueInstalledIdentities(
  entries: DocumentationCatalogEntry[],
): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.source}\0${entry.version}`;
    if (identities.has(identity)) {
      throw new Error(
        `Catalog contains more than one installed snapshot for ${entry.source}@${entry.version}`,
      );
    }
    identities.add(identity);
  }
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const file = await lstat(path).catch((cause: unknown) => {
    throw new Error(`Snapshot file is missing or unsafe: ${basename(path)}`, {
      cause,
    });
  });
  if (file.isSymbolicLink() || !file.isFile() || file.size > maximumBytes) {
    throw new Error(
      `Snapshot entry is not a safe regular file: ${basename(path)}`,
    );
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const openedFile = await handle.stat();
    if (!openedFile.isFile() || openedFile.size > maximumBytes) {
      throw new Error(
        `Snapshot entry changed while being read: ${basename(path)}`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseBuildManifest(bytes: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Snapshot manifest is not valid JSON', { cause });
  }
  const parsed = DocumentationBuildManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Snapshot manifest does not match the supported format', {
      cause: parsed.error,
    });
  }
  validateCatalogText(parsed.data.documentation.id, 256, 'Source');
  validateCatalogText(parsed.data.documentation.version, 64, 'Version');
  validateCatalogText(parsed.data.source.revision, 256, 'Revision');
  return parsed.data;
}

function parseCorpus(bytes: Buffer): DocumentationCorpus {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Snapshot corpus is not valid JSON', { cause });
  }
  const parsed = DocumentationCorpusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Snapshot corpus does not match the supported format', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertSnapshotIdentity(
  manifest: ReturnType<typeof DocumentationBuildManifestSchema.parse>,
  corpus: DocumentationCorpus,
): void {
  if (
    corpus.version !== manifest.documentation.version ||
    !sameProvenance(corpus.source, manifest.source) ||
    manifest.corpus.documentCount !== corpus.documents.length ||
    manifest.index.documentCount !== corpus.documents.length
  ) {
    throw new Error('Snapshot corpus identity does not match its manifest');
  }

  const corpusMetadata = [...corpus.documents]
    .sort((left, right) => compareStrings(left.source.path, right.source.path))
    .map((document) => ({
      id: document.id,
      path: document.source.path,
      sourceContentHash: document.source.contentHash,
      normalizedContentHash: document.contentHash,
    }));
  if (
    JSON.stringify(corpusMetadata) !== JSON.stringify(manifest.corpus.documents)
  ) {
    throw new Error('Snapshot document metadata does not match its manifest');
  }

  for (const document of corpus.documents) {
    assertSafeCanonicalUrl(document.canonicalUrl);
    if (
      sha256(Buffer.from(document.markdown, 'utf8')) !== document.contentHash
    ) {
      throw new Error(
        `Snapshot document content hash is invalid: ${document.id}`,
      );
    }
    for (const chunk of document.chunks) {
      assertSafeCanonicalUrl(chunk.canonicalUrl);
      if (sha256(Buffer.from(chunk.markdown, 'utf8')) !== chunk.contentHash) {
        throw new Error(
          `Snapshot section content hash is invalid: ${chunk.id}`,
        );
      }
    }
  }
}

function assertSnapshotHashes(
  manifest: ReturnType<typeof DocumentationBuildManifestSchema.parse>,
  corpus: Buffer,
  database: Buffer,
): void {
  if (
    sha256(corpus) !== manifest.corpus.sha256 ||
    sha256(database) !== manifest.index.sha256
  ) {
    throw new Error('Snapshot file hash does not match its manifest');
  }
}

function validateSnapshotIndex(
  databasePath: string,
  corpus: DocumentationCorpus,
  manifest: ReturnType<typeof DocumentationBuildManifestSchema.parse>,
): void {
  validateRuntimeDatabase(databasePath, runtimeManifestFromBuild(manifest));
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5000,
  });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Snapshot SQLite integrity check failed');
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
      .all(manifest.documentation.version);
    const expectedRows = corpus.documents
      .flatMap((document) =>
        document.chunks.map((chunk) => ({
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          documentId: document.id,
          title: document.title,
          headingPath: chunk.headingPath
            .map((heading) => heading.title)
            .join(' > '),
          markdown: chunk.markdown,
          canonicalUrl: chunk.canonicalUrl,
          sourceRevision: chunk.sourceRevision,
        })),
      )
      .sort(
        (left, right) =>
          compareStrings(left.documentId, right.documentId) ||
          left.chunkIndex - right.chunkIndex ||
          compareStrings(left.chunkId, right.chunkId),
      );
    if (actualRows.length !== expectedRows.length) {
      throw new Error('Snapshot SQLite row count does not match its corpus');
    }
    for (const [index, actual] of actualRows.entries()) {
      const expected = expectedRows[index];
      if (!expected || !snapshotRowMatches(actual, expected)) {
        throw new Error('Snapshot SQLite contents do not match its corpus');
      }
    }
  } finally {
    database.close();
  }
}

function snapshotRowMatches(
  actual: Record<string, unknown>,
  expected: {
    chunkId: string;
    chunkIndex: number;
    documentId: string;
    title: string;
    headingPath: string;
    markdown: string;
    canonicalUrl: string;
    sourceRevision: string;
  },
): boolean {
  return (
    actual.chunkId === expected.chunkId &&
    actual.chunkIndex === expected.chunkIndex &&
    actual.documentId === expected.documentId &&
    actual.title === expected.title &&
    actual.headingPath === expected.headingPath &&
    actual.markdown === expected.markdown &&
    actual.canonicalUrl === expected.canonicalUrl &&
    actual.sourceRevision === expected.sourceRevision
  );
}

function validateRuntimeDatabase(
  databasePath: string,
  manifest: DocumentationIndexRuntimeManifest,
): void {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5000,
  });
  try {
    const summary = validateRuntimeIndex(
      database,
      manifest.documentation.version,
    );
    if (
      manifest.index.file !== basename(databasePath) ||
      summary.revision !== manifest.index.sourceRevision ||
      summary.documentCount !== manifest.index.documentCount ||
      summary.chunkCount !== manifest.index.chunkCount
    ) {
      throw new Error('Snapshot SQLite metadata does not match its manifest');
    }
  } finally {
    database.close();
  }
}

function runtimeManifestFromBuild(
  manifest: ReturnType<typeof DocumentationBuildManifestSchema.parse>,
): DocumentationIndexRuntimeManifest {
  return DocumentationIndexRuntimeManifestSchema.parse({
    manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
    documentation: manifest.documentation,
    source: manifest.source,
    index: manifest.index,
  });
}

function catalogEntry(
  snapshot: ValidatedSnapshot,
  status: CatalogEntryStatus,
): DocumentationCatalogEntry {
  return {
    source: snapshot.source,
    version: snapshot.version,
    revision: snapshot.revision,
    status,
    databasePath: snapshot.databasePath,
    manifest: snapshot.manifest,
  };
}

function parseRuntimeManifest(
  bytes: Buffer,
): DocumentationIndexRuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Bundled documentation manifest is not valid JSON', {
      cause,
    });
  }
  const parsed = DocumentationIndexRuntimeManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Bundled documentation manifest is invalid', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertCatalogIdentity(entry: DocumentationCatalogEntry): void {
  validateCatalogText(entry.source, 256, 'Source');
  validateCatalogText(entry.version, 64, 'Version');
  validateCatalogText(entry.revision, 256, 'Revision');
}

function assertUniqueCatalogIdentities(
  entries: DocumentationCatalogEntry[],
): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    assertCatalogIdentity(entry);
    const identity = `${entry.source}\0${entry.version}`;
    if (identities.has(identity)) {
      throw new Error(
        `Catalog contains more than one index for ${entry.source}@${entry.version}`,
      );
    }
    identities.add(identity);
  }
}

function validateCatalogText(
  value: string,
  maximumLength: number,
  name: string,
): void {
  if (
    value.length > maximumLength ||
    !value.trim() ||
    containsControlCharacters(value)
  ) {
    throw new Error(`Snapshot ${name.toLowerCase()} is invalid`);
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertSafeCanonicalUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error('Snapshot canonical URL is invalid', { cause });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('Snapshot canonical URLs must be public HTTP(S) URLs');
  }
}

function sameProvenance(
  left: DocumentationCorpus['source'],
  right: DocumentationCorpus['source'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotDirectoryKey(source: string, version: string): string {
  return createHash('sha256')
    .update(`${source}\0${version}`, 'utf8')
    .digest('hex');
}

function snapshotStorageKey(snapshot: ValidatedSnapshot): string {
  return createHash('sha256')
    .update(
      `${snapshot.source}\0${snapshot.version}\0${snapshot.revision}\0${snapshot.manifest.index.sha256}`,
      'utf8',
    )
    .digest('hex');
}

function isValidSnapshotStorageKey(
  directoryKey: string,
  snapshot: ValidatedSnapshot,
): boolean {
  return (
    directoryKey === snapshotDirectoryKey(snapshot.source, snapshot.version) ||
    directoryKey === snapshotStorageKey(snapshot)
  );
}

function installedDatabasePath(
  snapshot: ValidatedSnapshot,
  options: CatalogOptions,
): string {
  const catalogRoot = options.catalogRoot ?? getUserCatalogDirectory();
  return join(
    catalogRoot,
    SNAPSHOTS_DIRECTORY_NAME,
    snapshotStorageKey(snapshot),
    'index.sqlite',
  );
}

function getPackageDataDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, '../../..', 'data');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertDirectoryIfPresent(
  path: string,
  name: string,
): Promise<void> {
  if (await pathExists(path)) await assertRealDirectory(path, name);
}

async function assertRealDirectory(path: string, name: string): Promise<void> {
  const info = await lstat(path).catch((cause: unknown) => {
    throw new Error(`${name} is missing or unsafe`, { cause });
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${name} must be a real directory`);
  }
}
