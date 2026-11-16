import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { GitDocumentationSource } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  addSnapshot,
  getCatalogIndex,
  validateSnapshotDirectory,
  type CatalogOptions,
  type DocumentationCatalogEntry,
} from './catalog.js';
import type { LocalBuildConfiguration, LocalBuildOptions } from './build.js';

const API_ORIGIN = 'https://api.github.com';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const GITHUB_WEB_ORIGIN = 'https://github.com';
const GITHUB_ALLOWED_HOSTS = new Set([
  'api.github.com',
  'raw.githubusercontent.com',
]);
const REQUEST_TIMEOUT_MS = 15_000;
const INGESTION_TIMEOUT_MS = 120_000;
const MAX_COMMIT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const DOWNLOAD_CONCURRENCY = 4;

const commitResponseSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/iu),
  commit: z.object({
    tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/iu) }),
  }),
});

const treeResponseSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.enum(['blob', 'tree', 'commit']),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

export type GitHubSnapshotBuilder = (
  configuration: LocalBuildConfiguration,
  options: LocalBuildOptions,
) => Promise<unknown>;

export interface GitHubSnapshotOptions extends CatalogOptions {
  /** Injectable HTTPS transport and builder for deterministic tests. */
  fetcher?: typeof fetch;
  snapshotBuilder?: GitHubSnapshotBuilder;
}

interface GitHubRepository {
  owner: string;
  name: string;
  canonicalUrl: string;
}

interface DocumentationFile {
  path: string;
  size: number;
}

/** Resolve a public GitHub ref, fetch bounded documentation, then install it. */
export async function installGitHubSnapshot(
  repositoryUrl: string,
  requestedRef: string,
  requestedDirectory: string,
  selector: string,
  options: GitHubSnapshotOptions = {},
): Promise<DocumentationCatalogEntry> {
  const repository = parseRepositoryUrl(repositoryUrl);
  const ref = validateGitRef(requestedRef);
  const directory = validateRepositoryPath(requestedDirectory, {
    allowRoot: true,
    name: 'Documentation directory',
  });
  const { source, version } = parseSelector(selector);
  validateSourceId(source);

  const { fetcher = fetch, snapshotBuilder, ...catalogOptions } = options;
  if (await getCatalogIndex(selector, catalogOptions)) {
    throw new Error(`Catalog already contains ${selector}`);
  }

  const timeoutSignal = AbortSignal.timeout(INGESTION_TIMEOUT_MS);
  const resolved = await resolveCommit(repository, ref, fetcher, timeoutSignal);
  const files = await listDocumentationFiles(
    repository,
    resolved.tree,
    directory,
    fetcher,
    timeoutSignal,
  );

  const stagingDirectory = await mkdtemp(
    join(tmpdir(), 'nekosearch-github-snapshot-'),
  );
  const inputDirectory = join(stagingDirectory, 'docs');
  const snapshotDirectory = join(stagingDirectory, 'snapshot');
  try {
    await mkdir(inputDirectory, { mode: 0o700 });
    await downloadDocumentationFiles(
      repository,
      resolved.revision,
      directory,
      files,
      inputDirectory,
      fetcher,
      timeoutSignal,
    );

    const configuration: LocalBuildConfiguration = {
      id: source,
      version,
      inputDirectory,
      outputDirectory: snapshotDirectory,
      routeMapping: {
        baseUrl: `${GITHUB_WEB_ORIGIN}/${repository.owner}/${repository.name}/blob/${resolved.revision}`,
        pathPrefix: directory,
        indexFileNames: ['index', 'readme'],
      },
    };
    const provenance: GitDocumentationSource = {
      kind: 'git',
      repository: repository.canonicalUrl,
      ref,
      directory: directory || '.',
      revision: resolved.revision,
    };
    const sourcePrefix = directory ? `${directory}/` : '';
    const sourceLocationForPath = (path: string) =>
      rawFileUrl(repository, resolved.revision, `${sourcePrefix}${path}`).href;

    await (snapshotBuilder ?? buildWithLocalIndexer)(configuration, {
      mode: 'clean',
      sourceProvenance: provenance,
      sourceLocationForPath,
    });
    const snapshot = await validateSnapshotDirectory(snapshotDirectory);
    if (
      snapshot.source !== source ||
      snapshot.version !== version ||
      snapshot.revision !== resolved.revision ||
      snapshot.manifest.documentation.id !== source ||
      snapshot.manifest.source.kind !== 'git' ||
      snapshot.manifest.source.repository !== repository.canonicalUrl ||
      snapshot.manifest.source.ref !== ref ||
      snapshot.manifest.source.directory !== (directory || '.')
    ) {
      throw new Error(
        `Built snapshot does not match the requested GitHub source ${selector}`,
      );
    }

    // No trackingRecipe is attached: generic GitHub provenance does not
    // authorize future upstream checks or updates.
    return await addSnapshot(snapshotDirectory, catalogOptions);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function parseRepositoryUrl(value: string): GitHubRepository {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(
      'Repository URL must be https://github.com/<owner>/<repository>',
      { cause },
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Only public https://github.com/<owner>/<repository> URLs are supported',
    );
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?$/u.exec(
    url.pathname,
  );
  if (!match?.[1] || !match[2]) {
    throw new Error(
      'Repository URL must contain exactly an owner and repository name, without a branch or file path',
    );
  }
  const name = match[2].replace(/\.git$/u, '');
  if (!isSafeGitHubName(match[1]) || !isSafeGitHubName(name)) {
    throw new Error('Repository URL contains an invalid owner or repository');
  }
  return {
    owner: match[1],
    name,
    canonicalUrl: `${GITHUB_WEB_ORIGIN}/${match[1]}/${name}`,
  };
}

function isSafeGitHubName(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..';
}

function validateGitRef(value: string): string {
  const segments = value.split('/');
  if (
    value === '@' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    containsControlOrSpace(value) ||
    [...value].some((character) =>
      ['~', '^', ':', '?', '*', '[', ']', '\\'].includes(character),
    ) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{') ||
    segments.some(
      (segment) =>
        !segment ||
        segment.startsWith('.') ||
        segment.endsWith('.') ||
        segment.endsWith('.lock'),
    )
  ) {
    throw new Error('GitHub ref is invalid or unsafe');
  }
  return value;
}

function validateRepositoryPath(
  value: string,
  options: { allowRoot: boolean; name: string },
): string {
  if (options.allowRoot && (value === '.' || value === '')) return '';
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${options.name} must be a safe relative repository path`);
  }
  const segments = value.split('/');
  if (
    segments.length > MAX_DOCUMENT_DEPTH ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        containsControlCharacter(segment) ||
        /[<>:"|?*]/u.test(segment) ||
        segment.endsWith('.') ||
        segment.endsWith(' '),
    )
  ) {
    throw new Error(`${options.name} contains an unsafe path component`);
  }
  return segments.join('/');
}

function parseSelector(selector: string): { source: string; version: string } {
  const separator = selector.lastIndexOf('@');
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(
      `Invalid source selector "${selector}"; use the form source@version`,
    );
  }
  const source = selector.slice(0, separator);
  const version = selector.slice(separator + 1);
  if (
    version.length > 64 ||
    !version.trim() ||
    containsControlCharacter(version)
  ) {
    throw new Error(
      'Source version must be a non-empty value of at most 64 characters',
    );
  }
  return { source, version };
}

function validateSourceId(value: string): void {
  if (value.length > 128 || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value)) {
    throw new Error(
      'Source ID must begin with a letter or number and contain only letters, numbers, dots, underscores, or hyphens',
    );
  }
}

async function resolveCommit(
  repository: GitHubRepository,
  ref: string,
  fetcher: typeof fetch,
  timeoutSignal: AbortSignal,
): Promise<{ revision: string; tree: string }> {
  const url = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(ref)}`,
    API_ORIGIN,
  );
  const body = await fetchGitHubBytes(
    url,
    fetcher,
    timeoutSignal,
    MAX_COMMIT_RESPONSE_BYTES,
    'commit ref',
  );
  let payload: unknown;
  try {
    payload = JSON.parse(decodeUtf8(body));
  } catch (cause) {
    throw new Error(
      `GitHub returned an invalid commit response for ref "${ref}"`,
      {
        cause,
      },
    );
  }
  const parsed = commitResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`GitHub did not resolve ref "${ref}" to a commit`);
  }
  return {
    revision: parsed.data.sha.toLowerCase(),
    tree: parsed.data.commit.tree.sha.toLowerCase(),
  };
}

async function listDocumentationFiles(
  repository: GitHubRepository,
  treeSha: string,
  directory: string,
  fetcher: typeof fetch,
  timeoutSignal: AbortSignal,
): Promise<DocumentationFile[]> {
  const url = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${treeSha}?recursive=1`,
    API_ORIGIN,
  );
  const body = await fetchGitHubBytes(
    url,
    fetcher,
    timeoutSignal,
    MAX_TREE_RESPONSE_BYTES,
    'repository tree',
  );
  let payload: unknown;
  try {
    payload = JSON.parse(decodeUtf8(body));
  } catch (cause) {
    throw new Error('GitHub returned an invalid repository tree response', {
      cause,
    });
  }
  const parsed = treeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('GitHub returned malformed repository tree metadata');
  }
  if (parsed.data.truncated) {
    throw new Error(
      'GitHub truncated the repository tree; choose a repository with a smaller tree or a narrower ingestion source',
    );
  }

  const prefix = directory ? `${directory}/` : '';
  const candidates: DocumentationFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const item of parsed.data.tree) {
    if (prefix && !item.path.startsWith(prefix)) continue;
    const relativePath = prefix ? item.path.slice(prefix.length) : item.path;
    if (!/\.mdx?$/u.test(relativePath)) continue;
    if (isExcludedLocalDocumentationPath(relativePath)) continue;
    validateRepositoryPath(item.path, {
      allowRoot: false,
      name: 'GitHub documentation path',
    });
    validateRepositoryPath(relativePath, {
      allowRoot: false,
      name: 'GitHub documentation path',
    });

    // Git mode 120000 marks symlinks; type commit/mode 160000 marks
    // submodules. Neither kind is downloaded or traversed.
    if (
      item.type !== 'blob' ||
      (item.mode !== '100644' && item.mode !== '100755')
    ) {
      continue;
    }
    if (item.size === undefined || item.size > MAX_FILE_BYTES) {
      throw new Error(
        `GitHub documentation file exceeds the ${MAX_FILE_BYTES}-byte per-file limit: ${relativePath}`,
      );
    }
    if (seen.has(relativePath)) {
      throw new Error(`GitHub tree contains a duplicate path: ${relativePath}`);
    }
    seen.add(relativePath);
    candidates.push({ path: relativePath, size: item.size });
    totalBytes += item.size;
    if (candidates.length > MAX_DOCUMENTS) {
      throw new Error(
        `GitHub documentation directory exceeds the ${MAX_DOCUMENTS}-file limit`,
      );
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `GitHub documentation directory exceeds the ${MAX_TOTAL_BYTES}-byte total limit`,
      );
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `No supported Markdown or MDX files found under GitHub directory "${directory || '.'}"`,
    );
  }
  return candidates.sort((left, right) =>
    compareStrings(left.path, right.path),
  );
}

async function downloadDocumentationFiles(
  repository: GitHubRepository,
  revision: string,
  directory: string,
  files: DocumentationFile[],
  inputDirectory: string,
  fetcher: typeof fetch,
  timeoutSignal: AbortSignal,
): Promise<void> {
  let nextIndex = 0;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && nextIndex < files.length) {
      const file = files[nextIndex++];
      if (!file) continue;
      try {
        const repositoryPath = directory
          ? `${directory}/${file.path}`
          : file.path;
        const bytes = await fetchGitHubBytes(
          rawFileUrl(repository, revision, repositoryPath),
          fetcher,
          timeoutSignal,
          MAX_FILE_BYTES,
          `documentation file ${file.path}`,
          file.size,
        );
        const markdown = decodeUtf8(bytes);
        const targetPath = join(inputDirectory, ...file.path.split('/'));
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        await writeFile(targetPath, markdown, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error('GitHub documentation download failed', {
                cause: error,
              });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(DOWNLOAD_CONCURRENCY, files.length) },
      worker,
    ),
  );
  if (failure) throw failure;
}

async function fetchGitHubBytes(
  url: URL,
  fetcher: typeof fetch,
  timeoutSignal: AbortSignal,
  maxBytes: number,
  purpose: string,
  expectedBytes?: number,
): Promise<Buffer> {
  assertAllowedGitHubUrl(url);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NekoSearch documentation snapshot installer',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.any([
        timeoutSignal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
  } catch (cause) {
    throw new Error(`GitHub request failed while fetching ${purpose}`, {
      cause,
    });
  }

  if (response.url) {
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url);
    } catch (cause) {
      throw new Error('GitHub returned an invalid response URL', { cause });
    }
    assertAllowedGitHubUrl(responseUrl);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `GitHub returned HTTP ${response.status} while fetching ${purpose}`,
    );
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `GitHub returned an invalid content length for ${purpose}`,
      );
    }
    if (Number(contentLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub ${purpose} exceeds the ${maxBytes}-byte limit`);
    }
  }

  const bytes = await readBoundedBody(response, maxBytes, purpose);
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new Error(
      `GitHub ${purpose} size did not match its pinned tree metadata`,
    );
  }
  return bytes;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  purpose: string,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub ${purpose} exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertAllowedGitHubUrl(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !GITHUB_ALLOWED_HOSTS.has(url.hostname)
  ) {
    throw new Error('GitHub ingestion attempted to access a disallowed host');
  }
}

function rawFileUrl(
  repository: GitHubRepository,
  revision: string,
  path: string,
): URL {
  const segments = [
    repository.owner,
    repository.name,
    revision,
    ...path.split('/'),
  ];
  return new URL(
    `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
    RAW_ORIGIN,
  );
}

async function buildWithLocalIndexer(
  configuration: LocalBuildConfiguration,
  options: LocalBuildOptions,
): Promise<unknown> {
  const { buildLocalSnapshotConfiguration } = await import('./build.js');
  return buildLocalSnapshotConfiguration(configuration, options);
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error('GitHub documentation must be valid UTF-8 text', { cause });
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExcludedLocalDocumentationPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => ['.git', 'node_modules'].includes(segment));
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function containsControlOrSpace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}
