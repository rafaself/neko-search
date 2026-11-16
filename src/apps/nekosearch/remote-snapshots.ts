import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import {
  DOCUMENTATION_BUILD_MANIFEST_VERSION,
  DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
  DocumentationIndexRuntimeManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import {
  addSnapshot,
  listCatalogIndexes,
  updateSnapshot,
  type CatalogOptions,
  type SnapshotUpdateResult,
  validateSnapshotDirectory,
} from './catalog.js';

const OFFICIAL_REPOSITORY = 'rafaself/neko-search';
const OFFICIAL_REPOSITORY_ID = 1455942811;
const OFFICIAL_SOURCE_REPOSITORY = 'https://github.com/nestjs/docs.nestjs.com';
const RELEASE_API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}`;
const RELEASE_ASSET_NAME = 'documentation-indexes.tar.gz';
const SUPPORTED_VERSIONS = ['11', '12'] as const;
const EXPECTED_SOURCE_REFS: Record<
  (typeof SUPPORTED_VERSIONS)[number],
  string
> = {
  '11': '11.0.0',
  '12': 'master',
};
const MAX_RELEASES_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_PIPELINE = {
  parserVersion: 1,
  transformerVersion: 1,
  normalizationAlgorithmVersion: 1,
  chunkingAlgorithmVersion: 1,
  maxChunkChars: 4000,
};
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const API_USER_AGENT = 'nekosearch-documentation-snapshot-installer';

type NestJsVersion = (typeof SUPPORTED_VERSIONS)[number];
type RemoteOperation = 'add' | 'update';

interface ReleaseAsset {
  name: string;
  size: number;
  digest: string | null;
  state: string;
  browser_download_url: string;
}

interface ReleaseRecord {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets_url: string;
  assets: ReleaseAsset[];
}

interface ReleaseBundleManifest {
  formatVersion: number;
  indexPipelineVersion: number;
  repository: string;
  versions: Record<string, ReleaseBundleVersion>;
}

interface ReleaseBundleVersion {
  version: number;
  ref: string;
  revision: string;
  documentCount: number;
  chunkCount: number;
  sourceContentHashes: Record<string, string>;
  normalizedContentHashes: Record<string, string>;
  corpusSha256: string;
  indexSha256: string;
}

export interface RemoteSnapshotOptions extends CatalogOptions {
  /** Injectable transport for deterministic offline tests. */
  fetcher?: typeof fetch;
}

export type RemoteSnapshotResult = SnapshotUpdateResult;

/** Fetch and verify an official prerelease snapshot, then atomically activate it. */
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
  const release = await findLatestRelease(fetcher, targetVersion);
  const releaseRevision = parseReleaseRevision(release.body, targetVersion);
  const asset = findReleaseAsset(release);
  if (operation === 'update' && current?.revision === releaseRevision) {
    return { entry: current, changed: false };
  }

  const archive = await downloadReleaseArchive(fetcher, release, asset);
  const archiveFiles = parseReleaseArchive(archive);
  const snapshotDirectory = await mkdtemp(
    join(tmpdir(), 'nekosearch-remote-snapshot-'),
  );
  try {
    await createSnapshotDirectory(
      snapshotDirectory,
      targetVersion,
      releaseRevision,
      archiveFiles,
    );
    const validated = await validateSnapshotDirectory(snapshotDirectory);
    if (
      validated.source !== source ||
      validated.version !== version ||
      validated.revision !== releaseRevision
    ) {
      throw new Error(
        'Downloaded release does not match the requested snapshot',
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
      `Remote snapshots support only nestjs@${SUPPORTED_VERSIONS.join(' and nestjs@')}`,
    );
  }
  return version as NestJsVersion;
}

async function findLatestRelease(
  fetcher: typeof fetch,
  targetVersion: NestJsVersion,
): Promise<ReleaseRecord> {
  const repository = await fetchJson(fetcher, RELEASE_API, 1024 * 1024);
  if (
    !isRecord(repository) ||
    repository.id !== OFFICIAL_REPOSITORY_ID ||
    repository.full_name !== OFFICIAL_REPOSITORY
  ) {
    throw new Error(
      'Official documentation release repository identity changed',
    );
  }

  const releasesValue = await fetchJson(
    fetcher,
    `${RELEASE_API}/releases?per_page=100`,
    MAX_RELEASES_BYTES,
  );
  if (!Array.isArray(releasesValue)) {
    throw new Error('Official documentation release list is invalid');
  }
  const candidates = releasesValue
    .filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        typeof candidate.tag_name === 'string' &&
        /^docs-index-[a-zA-Z0-9._-]+$/u.test(candidate.tag_name) &&
        candidate.draft === false &&
        candidate.prerelease === true &&
        typeof candidate.published_at === 'string',
    )
    .filter((release) =>
      Number.isFinite(Date.parse(release.published_at as string)),
    )
    .sort(
      (left, right) =>
        Date.parse(right.published_at as string) -
        Date.parse(left.published_at as string),
    );
  const newestCandidate = candidates[0];
  if (!newestCandidate) {
    throw new Error('No published documentation index release exists');
  }
  if (!isReleaseRecord(newestCandidate)) {
    throw new Error('Newest documentation index release metadata is invalid');
  }
  const release = newestCandidate;

  const expectedAssetsUrl = `${RELEASE_API}/releases/${release.id}/assets`;
  if (release.assets_url !== expectedAssetsUrl) {
    throw new Error('Documentation release asset origin is invalid');
  }
  parseReleaseRevision(release.body, targetVersion);
  return release;
}

function isReleaseRecord(value: unknown): value is ReleaseRecord {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.id) &&
    typeof value.tag_name === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    (typeof value.body === 'string' || value.body === null) &&
    typeof value.draft === 'boolean' &&
    typeof value.prerelease === 'boolean' &&
    (typeof value.published_at === 'string' || value.published_at === null) &&
    typeof value.created_at === 'string' &&
    typeof value.assets_url === 'string' &&
    Array.isArray(value.assets) &&
    value.assets.every(isReleaseAsset)
  );
}

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Number.isSafeInteger(value.size) &&
    (typeof value.digest === 'string' || value.digest === null) &&
    typeof value.state === 'string' &&
    typeof value.browser_download_url === 'string'
  );
}

function parseReleaseRevision(
  body: string | null,
  version: NestJsVersion,
): string {
  const line = body
    ?.split(/\r?\n/u)
    .find((candidate) =>
      candidate.includes(`NestJS v${version} source revision:`),
    );
  const revision = line?.match(/\b([a-f0-9]{40})\b/u)?.[1];
  if (!revision) {
    throw new Error(
      `Release metadata does not identify the NestJS v${version} revision`,
    );
  }
  return revision;
}

function findReleaseAsset(release: ReleaseRecord): ReleaseAsset & {
  sha256: string;
} {
  const matches = release.assets.filter(
    (asset) => asset.name === RELEASE_ASSET_NAME,
  );
  const asset = matches[0];
  if (matches.length !== 1 || !asset || asset.state !== 'uploaded') {
    throw new Error('Official release is missing its index archive');
  }
  // The TLS-authenticated, repository-pinned GitHub API is the trust root.
  // A checksum embedded beside the archive is never used to authenticate it.
  const digest = /^sha256:([a-f0-9]{64})$/u.exec(asset.digest ?? '')?.[1];
  const expectedUrl =
    `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/` +
    `${encodeURIComponent(release.tag_name)}/${RELEASE_ASSET_NAME}`;
  if (
    !digest ||
    asset.size <= 0 ||
    asset.size > MAX_RELEASE_ARCHIVE_BYTES ||
    asset.browser_download_url !== expectedUrl
  ) {
    throw new Error('Official release archive metadata is invalid');
  }
  return { ...asset, sha256: digest };
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  maximumBytes: number,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub release API returned HTTP ${response.status}`);
  }
  const body = await readResponseBody(response, maximumBytes);
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('GitHub release API returned invalid JSON', { cause });
  }
}

async function downloadReleaseArchive(
  fetcher: typeof fetch,
  release: ReleaseRecord,
  asset: ReleaseAsset & { sha256: string },
): Promise<Buffer> {
  const initialUrl = new URL(asset.browser_download_url);
  const expectedBase = `/${OFFICIAL_REPOSITORY}/releases/download/${release.tag_name}/${RELEASE_ASSET_NAME}`;
  if (
    initialUrl.protocol !== 'https:' ||
    initialUrl.hostname !== 'github.com' ||
    initialUrl.pathname !== expectedBase ||
    initialUrl.username.length > 0 ||
    initialUrl.password.length > 0
  ) {
    throw new Error('Release archive URL is outside the official origin');
  }

  const response = await fetchWithGithubRedirects(fetcher, initialUrl.href);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `Release archive download returned HTTP ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > 0 &&
    declaredLength !== asset.size
  ) {
    await response.body.cancel();
    throw new Error(
      'Release archive response length does not match its metadata',
    );
  }
  const bytes = await readResponseBody(response, asset.size);
  if (bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error('Release archive failed its authenticated SHA-256 check');
  }
  return bytes;
}

async function fetchWithGithubRedirects(
  fetcher: typeof fetch,
  initialUrl: string,
): Promise<Response> {
  let currentUrl = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetcher(currentUrl, {
      signal: AbortSignal.timeout(60_000),
      redirect: 'manual',
      headers: {
        accept: 'application/octet-stream',
        'user-agent': API_USER_AGENT,
      },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirectCount === 3) {
      throw new Error('Release archive redirect chain is invalid');
    }
    const nextUrl = new URL(location, currentUrl);
    if (
      nextUrl.protocol !== 'https:' ||
      nextUrl.port !== '' ||
      !ALLOWED_DOWNLOAD_HOSTS.has(nextUrl.hostname) ||
      nextUrl.username.length > 0 ||
      nextUrl.password.length > 0
    ) {
      throw new Error('Release archive redirected outside GitHub asset hosts');
    }
    currentUrl = nextUrl;
  }
  throw new Error('Release archive redirect limit was exceeded');
}

async function readResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('Release download returned an invalid data chunk');
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error('Downloaded release data exceeds its size limit');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (cause) {
    throw new Error('Release download was interrupted', { cause });
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseReleaseArchive(archive: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, {
      maxOutputLength: MAX_UNCOMPRESSED_ARCHIVE_BYTES,
    });
  } catch (cause) {
    throw new Error('Official release archive is not a supported gzip stream', {
      cause,
    });
  }

  const files = new Map<string, Buffer>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) {
      throw new Error('Release archive contains data after its terminator');
    }
    verifyTarHeader(header);
    const filename = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${filename}` : filename;
    const type = header[156];
    const size = parseTarOctal(header.subarray(124, 136));
    if (
      !filename ||
      path.includes('..') ||
      path.startsWith('/') ||
      (type !== 0 && type !== 48) ||
      size > MAX_ARCHIVE_ENTRY_BYTES
    ) {
      throw new Error('Release archive contains an unsafe or oversized entry');
    }
    const allowedNames = releaseArchiveNames();
    if (!allowedNames.has(path) || files.has(path)) {
      throw new Error(
        'Release archive contains an unexpected or duplicate file',
      );
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) {
      throw new Error('Release archive ended before a file was complete');
    }
    files.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || !files.has('manifest.json')) {
    throw new Error('Release archive is incomplete');
  }
  const requiredNames = new Set([
    'manifest.json',
    ...SUPPORTED_VERSIONS.flatMap((version) => [
      `documentation-v${version}.json`,
      `documentation-v${version}.sqlite`,
    ]),
  ]);
  const hasRuntimeManifests = SUPPORTED_VERSIONS.every((version) =>
    files.has(`documentation-v${version}.manifest.json`),
  );
  if (hasRuntimeManifests) {
    for (const version of SUPPORTED_VERSIONS) {
      requiredNames.add(`documentation-v${version}.manifest.json`);
    }
  }
  if (
    files.size !== requiredNames.size ||
    [...requiredNames].some((name) => !files.has(name))
  ) {
    throw new Error('Release archive does not match a supported bundle format');
  }
  return files;
}

function releaseArchiveNames(): Set<string> {
  return new Set([
    'manifest.json',
    ...SUPPORTED_VERSIONS.flatMap((version) => [
      `documentation-v${version}.json`,
      `documentation-v${version}.sqlite`,
      `documentation-v${version}.manifest.json`,
    ]),
  ]);
}

function verifyTarHeader(header: Buffer): void {
  const magic = header.subarray(257, 263).toString('ascii');
  if (magic !== 'ustar\0' && magic !== 'ustar ') {
    throw new Error('Release archive uses an unsupported tar format');
  }
  const expectedChecksum = parseTarOctal(header.subarray(148, 156));
  let actualChecksum = 0;
  for (let index = 0; index < 512; index += 1) {
    actualChecksum += index >= 148 && index <= 155 ? 32 : (header[index] ?? 0);
  }
  if (expectedChecksum !== actualChecksum) {
    throw new Error('Release archive tar header checksum is invalid');
  }
}

function readTarString(field: Buffer): string {
  const terminator = field.indexOf(0);
  return field
    .subarray(0, terminator < 0 ? field.byteLength : terminator)
    .toString('utf8');
}

function parseTarOctal(field: Buffer): number {
  const value = field.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error('Release archive has an invalid tar numeric field');
  }
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) {
    throw new Error('Release archive tar field exceeds the safe integer range');
  }
  return result;
}

async function createSnapshotDirectory(
  directory: string,
  version: NestJsVersion,
  releaseRevision: string,
  files: Map<string, Buffer>,
): Promise<void> {
  const bundleManifest = parseBundleManifest(files.get('manifest.json'));
  const bundleVersion = bundleManifest.versions[version];
  const corpusBytes = files.get(`documentation-v${version}.json`);
  const indexBytes = files.get(`documentation-v${version}.sqlite`);
  if (!bundleVersion || !corpusBytes || !indexBytes) {
    throw new Error(`Release does not contain a NestJS v${version} index`);
  }
  if (
    bundleVersion.version !== Number(version) ||
    bundleVersion.ref !== EXPECTED_SOURCE_REFS[version] ||
    bundleVersion.revision !== releaseRevision ||
    !/^[a-f0-9]{40}$/u.test(bundleVersion.revision) ||
    sha256(corpusBytes) !== bundleVersion.corpusSha256 ||
    sha256(indexBytes) !== bundleVersion.indexSha256
  ) {
    throw new Error(
      'Release bundle identity or integrity does not match metadata',
    );
  }

  const corpus = parseCorpus(corpusBytes);
  if (
    corpus.version !== version ||
    corpus.source.kind !== 'git' ||
    corpus.source.repository !== OFFICIAL_SOURCE_REPOSITORY ||
    corpus.source.ref !== bundleVersion.ref ||
    corpus.source.revision !== releaseRevision ||
    corpus.documents.length !== bundleVersion.documentCount
  ) {
    throw new Error(
      'Release corpus does not match the requested source and version',
    );
  }
  assertCorpusHashLists(corpus, bundleVersion);

  const releasedRuntimeManifest = files.get(
    `documentation-v${version}.manifest.json`,
  );
  let runtimeManifest: ReturnType<
    typeof DocumentationIndexRuntimeManifestSchema.parse
  >;
  if (releasedRuntimeManifest) {
    runtimeManifest = parseRuntimeManifest(releasedRuntimeManifest);
    if (
      runtimeManifest.documentation.id !== OFFICIAL_SOURCE_REPOSITORY ||
      runtimeManifest.documentation.version !== version ||
      runtimeManifest.source.kind !== 'git' ||
      runtimeManifest.source.repository !== OFFICIAL_SOURCE_REPOSITORY ||
      runtimeManifest.source.ref !== bundleVersion.ref ||
      runtimeManifest.source.revision !== releaseRevision ||
      runtimeManifest.index.file !== `documentation-v${version}.sqlite` ||
      runtimeManifest.index.sha256 !== bundleVersion.indexSha256 ||
      runtimeManifest.index.documentCount !== bundleVersion.documentCount ||
      runtimeManifest.index.chunkCount !== bundleVersion.chunkCount
    ) {
      throw new Error(
        'Release runtime manifest does not match its index bundle',
      );
    }
  } else {
    runtimeManifest = DocumentationIndexRuntimeManifestSchema.parse({
      manifestVersion: DOCUMENTATION_RUNTIME_MANIFEST_VERSION,
      documentation: { id: OFFICIAL_SOURCE_REPOSITORY, version },
      source: corpus.source,
      index: {
        file: `documentation-v${version}.sqlite`,
        sha256: bundleVersion.indexSha256,
        documentationVersion: version,
        sourceRevision: releaseRevision,
        schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
        formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
        documentCount: bundleVersion.documentCount,
        chunkCount: bundleVersion.chunkCount,
      },
    });
  }
  if (
    runtimeManifest.index.schemaVersion !==
      DOCUMENTATION_INDEX_SCHEMA_VERSION ||
    runtimeManifest.index.formatVersion !== DOCUMENTATION_INDEX_FORMAT_VERSION
  ) {
    throw new Error('Release SQLite format is incompatible with this CLI');
  }

  const buildManifest = {
    manifestVersion: DOCUMENTATION_BUILD_MANIFEST_VERSION,
    documentation: { id: 'nestjs', version },
    source: corpus.source,
    pipeline: {
      ...SNAPSHOT_PIPELINE,
      indexSchemaVersion: runtimeManifest.index.schemaVersion,
      indexFormatVersion: runtimeManifest.index.formatVersion,
    },
    corpus: {
      file: 'corpus.json',
      sha256: sha256(corpusBytes),
      documentCount: corpus.documents.length,
      documents: [...corpus.documents]
        .sort((left, right) =>
          compareStrings(left.source.path, right.source.path),
        )
        .map((document) => ({
          id: document.id,
          path: document.source.path,
          sourceContentHash: document.source.contentHash,
          normalizedContentHash: document.contentHash,
        })),
    },
    index: {
      ...runtimeManifest.index,
      file: 'index.sqlite',
      sha256: sha256(indexBytes),
      documentationVersion: version,
      sourceRevision: releaseRevision,
    },
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(directory, 'corpus.json'), corpusBytes, {
      flag: 'wx',
      mode: 0o600,
    }),
    writeFile(join(directory, 'index.sqlite'), indexBytes, {
      flag: 'wx',
      mode: 0o600,
    }),
    writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify(buildManifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    ),
  ]);
}

function parseBundleManifest(bytes: Buffer | undefined): ReleaseBundleManifest {
  if (!bytes || bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new Error('Release bundle manifest is missing or too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Release bundle manifest is invalid JSON', { cause });
  }
  if (
    !isRecord(value) ||
    hasOnlyKeys(value, [
      'formatVersion',
      'indexPipelineVersion',
      'repository',
      'versions',
    ]) !== true ||
    value.formatVersion !== 1 ||
    value.indexPipelineVersion !== 2 ||
    value.repository !== OFFICIAL_SOURCE_REPOSITORY ||
    !isRecord(value.versions) ||
    hasOnlyKeys(value.versions, ['11', '12']) !== true
  ) {
    throw new Error('Release bundle format is not supported');
  }
  const versions: Record<string, ReleaseBundleVersion> = {};
  for (const supportedVersion of SUPPORTED_VERSIONS) {
    const candidate = value.versions[supportedVersion];
    if (
      !isRecord(candidate) ||
      hasOnlyKeys(candidate, [
        'version',
        'ref',
        'revision',
        'documentCount',
        'chunkCount',
        'sourceContentHashes',
        'normalizedContentHashes',
        'corpusSha256',
        'indexSha256',
      ]) !== true ||
      candidate.version !== Number(supportedVersion) ||
      candidate.ref !== EXPECTED_SOURCE_REFS[supportedVersion] ||
      typeof candidate.revision !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(candidate.revision) ||
      !Number.isSafeInteger(candidate.documentCount) ||
      Number(candidate.documentCount) < 1 ||
      !Number.isSafeInteger(candidate.chunkCount) ||
      Number(candidate.chunkCount) < 1 ||
      !isRecord(candidate.sourceContentHashes) ||
      !isRecord(candidate.normalizedContentHashes) ||
      !Object.values(candidate.sourceContentHashes).every(isSha256) ||
      !Object.values(candidate.normalizedContentHashes).every(isSha256) ||
      typeof candidate.corpusSha256 !== 'string' ||
      typeof candidate.indexSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.corpusSha256) ||
      !/^[a-f0-9]{64}$/u.test(candidate.indexSha256)
    ) {
      throw new Error(
        `Release bundle metadata for v${supportedVersion} is invalid`,
      );
    }
    versions[supportedVersion] = candidate as unknown as ReleaseBundleVersion;
  }
  return {
    formatVersion: 1,
    indexPipelineVersion: 2,
    repository: OFFICIAL_SOURCE_REPOSITORY,
    versions,
  };
}

function parseCorpus(bytes: Buffer): DocumentationCorpus {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Release documentation corpus is invalid JSON', { cause });
  }
  const parsed = DocumentationCorpusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Release documentation corpus format is unsupported', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseRuntimeManifest(bytes: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error('Release runtime manifest is invalid JSON', { cause });
  }
  const parsed = DocumentationIndexRuntimeManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Release runtime manifest format is unsupported', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertCorpusHashLists(
  corpus: DocumentationCorpus,
  metadata: ReleaseBundleVersion,
): void {
  const sourceHashes = Object.fromEntries(
    corpus.documents.map((document) => [
      document.id,
      document.source.contentHash,
    ]),
  );
  const normalizedHashes = Object.fromEntries(
    corpus.documents.map((document) => [document.id, document.contentHash]),
  );
  if (
    JSON.stringify(sourceHashes) !==
      JSON.stringify(metadata.sourceContentHashes) ||
    JSON.stringify(normalizedHashes) !==
      JSON.stringify(metadata.normalizedContentHashes)
  ) {
    throw new Error('Release bundle document hashes do not match the corpus');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const keys = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
