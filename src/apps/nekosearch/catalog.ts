import { createHash } from 'node:crypto';
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
  const catalogRoot = options.catalogRoot ?? getUserCatalogDirectory();
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

  const snapshotsDirectory = join(catalogRoot, SNAPSHOTS_DIRECTORY_NAME);
  await assertDirectoryIfPresent(catalogRoot, 'Catalog directory');
  await assertDirectoryIfPresent(snapshotsDirectory, 'Snapshots directory');

  const targetDirectory = join(
    snapshotsDirectory,
    snapshotDirectoryKey(snapshot.source, snapshot.version),
  );
  await assertMissing(targetDirectory, 'Snapshot catalog entry');

  await mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(snapshotsDirectory, 'Snapshots directory');
  const stagingDirectory = await mkdtemp(join(snapshotsDirectory, '.pending-'));
  try {
    await writeFile(
      join(stagingDirectory, 'corpus.json'),
      snapshot.files.corpus,
      {
        flag: 'wx',
        mode: 0o600,
      },
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
    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return catalogEntry(
    {
      ...snapshot,
      databasePath: join(targetDirectory, 'index.sqlite'),
    },
    'installed',
  );
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

async function assertMissing(path: string, name: string): Promise<void> {
  if (await pathExists(path)) throw new Error(`${name} already exists`);
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
