import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getUserDataDirectory } from './catalog.js';
import {
  inspectTransformersRuntime,
  ONNX_RUNTIME_NODE_VERSION,
  TRANSFORMERS_VERSION,
} from './transformers-runtime.js';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';

const MODEL_ID = QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelId;
const MODEL_VERSION = '1.0.0';
const UPSTREAM_REPOSITORY = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const UPSTREAM_REVISION = QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelRevision;
const RELEASE_REPOSITORY = 'rafaself/nekosearch-models';
const RELEASE_TAG = `${MODEL_ID}-v${MODEL_VERSION}`;
const RELEASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}`;
const MANIFEST_SHA256 =
  '55fd3219ff70bb57bab85ab25f2336a5a75e1fda78484e4ba1505f4c6be10144';
const CHECKSUMS_SHA256 =
  '3a86d1556514d362d6850f089e280b88dccb1fa29c3231d530b59c4fb67119b2';
const MANIFEST_FILE = 'manifest.json';
const CHECKSUMS_FILE = 'SHA256SUMS';
const MARKER_FILE = '.nekosearch-managed.json';
const INSTALLING_DIRECTORY = '.installing';
const INSTALL_LOCK_DIRECTORY = '.install-lock';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_CHECKSUMS_BYTES = 16 * 1024;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const ARTIFACT_NAMES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'model_quantized.onnx',
  'Apache-2.0.txt',
  'NOTICE',
] as const;
const INFERENCE_ARTIFACT_NAMES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'model_quantized.onnx',
] as const;
const RELEASE_ASSET_NAMES = [
  MANIFEST_FILE,
  CHECKSUMS_FILE,
  ...ARTIFACT_NAMES,
] as const;

interface ModelArtifact {
  name: string;
  sha256: string;
  sizeBytes: number;
  requiredForInference: boolean;
}

interface ModelManifest {
  schemaVersion: number;
  modelId: string;
  version: string;
  release: {
    repository: string;
    tag: string;
    checksums: string;
  };
  upstream: {
    repository: string;
    revision: string;
  };
  model: {
    architecture: string;
    format: string;
    contextLength: number;
    embeddingDimensions: number;
    pooling: string;
    normalization: string;
  };
  tokenizer: {
    class: string;
    algorithm: string;
    files: string[];
    paddingSide: string;
    padToken: string;
    eosToken: string;
  };
  runtime: {
    package: string;
    version: string;
    onnxruntimeNodeVersion: string;
    nodeVersion: string;
    platform: string;
    architecture: string;
    task: string;
    device: string;
    dtype: string;
    subfolder: string;
    externalData: boolean;
    recommendedBatchSize: number;
  };
  artifacts: ModelArtifact[];
}

interface ManagedMarker {
  application: 'nekosearch';
  modelId: string;
  version: string;
  releaseTag: string;
  manifestSha256: string;
}

export interface ModelManagerOptions {
  /** Exact model installation directory. Defaults to the persistent user data directory. */
  modelDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  progress?: (message: string) => void;
  /** Test seam for deterministic local release fixtures. The CLI uses pinned release values. */
  release?: ModelRelease;
}

export interface ModelRelease {
  url: string;
  repository: string;
  tag: string;
  manifestSha256: string;
  manifestBytes: number;
  checksumsSha256: string;
  checksumsBytes: number;
}

export interface ModelStatus {
  modelId: typeof MODEL_ID;
  installationState: 'not-installed' | 'unmanaged' | 'installed' | 'corrupt';
  version: typeof MODEL_VERSION;
  upstreamRevision: typeof UPSTREAM_REVISION;
  modelDirectory: string;
  artifactIntegrity: 'valid' | 'invalid' | 'missing' | 'unmanaged';
  runtimeAvailable: boolean;
  inferenceAvailable: boolean;
  runtimeRequirement: string;
  details: string[];
  unmanagedFiles: string[];
}

const PINNED_RELEASE: ModelRelease = {
  url: RELEASE_URL,
  repository: RELEASE_REPOSITORY,
  tag: RELEASE_TAG,
  manifestSha256: MANIFEST_SHA256,
  manifestBytes: 3461,
  checksumsSha256: CHECKSUMS_SHA256,
  checksumsBytes: 568,
};

export function resolveModelDirectory(
  options: Pick<ModelManagerOptions, 'modelDirectory' | 'environment'> = {},
): string {
  const environment = options.environment ?? process.env;
  const override =
    options.modelDirectory?.trim() || environment.NEKOSEARCH_MODEL_DIR?.trim();
  return resolve(
    override ||
      join(
        getUserDataDirectory(environment),
        'models',
        MODEL_ID,
        MODEL_VERSION,
      ),
  );
}

export async function installModel(
  options: ModelManagerOptions = {},
): Promise<{ modelDirectory: string; alreadyInstalled: boolean }> {
  const release = options.release ?? PINNED_RELEASE;
  const modelDirectory = resolveModelDirectory(options);
  const parentDirectory = dirname(modelDirectory);
  const stagedDirectory = join(
    parentDirectory,
    `.${basename(modelDirectory)}${INSTALLING_DIRECTORY}`,
  );
  const lockDirectory = join(
    parentDirectory,
    `.${basename(modelDirectory)}${INSTALL_LOCK_DIRECTORY}`,
  );

  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireInstallLock(lockDirectory);
  const progress =
    options.progress ??
    ((message: string) => process.stderr.write(`\r${message}`));

  try {
    const existing = await getModelStatus({
      ...options,
      modelDirectory,
      release,
    });
    if (existing.installationState === 'installed') {
      return { modelDirectory, alreadyInstalled: true };
    }
    if (existing.installationState !== 'not-installed') {
      throw new Error(
        `Refusing to replace the ${existing.installationState} model directory at ${modelDirectory}; remove only a NekoSearch-managed installation first`,
      );
    }

    await prepareStagingDirectory(stagedDirectory, release);
    await ensureStagingMarker(stagedDirectory, release);
    const fetcher = options.fetcher ?? fetch;

    const manifestFile = join(stagedDirectory, MANIFEST_FILE);
    if (!(await fileMatchesDigest(manifestFile, release.manifestSha256))) {
      await downloadReleaseAsset(
        `${release.url}/${MANIFEST_FILE}`,
        manifestFile,
        release.manifestBytes,
        release.manifestSha256,
        fetcher,
        progress,
      );
    }

    const checksumsFile = join(stagedDirectory, CHECKSUMS_FILE);
    if (!(await fileMatchesDigest(checksumsFile, release.checksumsSha256))) {
      await downloadReleaseAsset(
        `${release.url}/${CHECKSUMS_FILE}`,
        checksumsFile,
        release.checksumsBytes,
        release.checksumsSha256,
        fetcher,
        progress,
      );
    }

    const verifiedManifest = parseAndValidateManifest(
      await readRegularFile(manifestFile, MAX_MANIFEST_BYTES),
      release,
    );
    verifyChecksumIndex(
      await readRegularFile(checksumsFile, MAX_CHECKSUMS_BYTES),
      verifiedManifest,
      release,
    );

    for (const artifact of verifiedManifest.artifacts) {
      const destination = join(stagedDirectory, artifact.name);
      if (await fileMatchesArtifact(destination, artifact)) continue;
      await downloadReleaseAsset(
        `${release.url}/${artifact.name}`,
        destination,
        artifact.sizeBytes,
        artifact.sha256,
        fetcher,
        progress,
      );
    }

    await verifyModelFiles(stagedDirectory, verifiedManifest, release);
    const marker: ManagedMarker = {
      application: 'nekosearch',
      modelId: MODEL_ID,
      version: MODEL_VERSION,
      releaseTag: release.tag,
      manifestSha256: release.manifestSha256,
    };
    await writeFile(
      join(stagedDirectory, MARKER_FILE),
      JSON.stringify({ ...marker, state: 'complete' }),
    );

    if (await pathExists(modelDirectory)) {
      throw new Error(
        `The model directory appeared during installation and was left unchanged: ${modelDirectory}`,
      );
    }
    await rename(stagedDirectory, modelDirectory);
    return { modelDirectory, alreadyInstalled: false };
  } finally {
    await releaseLock();
    progress('\n');
  }
}

export async function getModelStatus(
  options: ModelManagerOptions = {},
): Promise<ModelStatus> {
  const release = options.release ?? PINNED_RELEASE;
  const modelDirectory = resolveModelDirectory(options);
  const runtimeRequirement = `@huggingface/transformers@${TRANSFORMERS_VERSION} with onnxruntime-node@${ONNX_RUNTIME_NODE_VERSION} on Linux x64 with Node.js >=24.15.0`;
  const hostProblem = getRuntimeHostProblem();
  const runtime = hostProblem
    ? { available: false as const, detail: hostProblem }
    : inspectTransformersRuntime();
  const base: ModelStatus = {
    modelId: MODEL_ID,
    installationState: 'not-installed',
    version: MODEL_VERSION,
    upstreamRevision: UPSTREAM_REVISION,
    modelDirectory,
    artifactIntegrity: 'missing',
    runtimeAvailable: runtime.available,
    inferenceAvailable: false,
    runtimeRequirement,
    details: runtime.available ? [] : [runtime.detail],
    unmanagedFiles: [],
  };

  let directoryStat;
  try {
    directoryStat = await lstat(modelDirectory);
  } catch (error) {
    if (isMissingPath(error)) return base;
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return {
      ...base,
      installationState: 'unmanaged',
      artifactIntegrity: 'unmanaged',
      details: ['The model path is not a regular directory'],
    };
  }

  const markerPath = join(modelDirectory, MARKER_FILE);
  let marker;
  try {
    marker = JSON.parse(
      (await readRegularFile(markerPath, 4096)).toString('utf8'),
    ) as unknown;
  } catch (error) {
    if (isMissingPath(error)) {
      return {
        ...base,
        installationState: 'unmanaged',
        artifactIntegrity: 'unmanaged',
        details: ['No NekoSearch ownership marker is present'],
        unmanagedFiles: await readdir(modelDirectory),
      };
    }
    return {
      ...base,
      installationState: 'corrupt',
      artifactIntegrity: 'invalid',
      details: [errorMessage(error)],
    };
  }

  if (!isManagedMarker(marker, release)) {
    return {
      ...base,
      installationState: 'unmanaged',
      artifactIntegrity: 'unmanaged',
      details: [
        'The ownership marker does not match this pinned model release',
      ],
      unmanagedFiles: await readdir(modelDirectory),
    };
  }

  try {
    const manifestBytes = await readRegularFile(
      join(modelDirectory, MANIFEST_FILE),
      MAX_MANIFEST_BYTES,
    );
    if (sha256(manifestBytes) !== release.manifestSha256) {
      throw new Error(
        'Release manifest SHA-256 does not match the pinned release',
      );
    }
    const manifest = parseAndValidateManifest(manifestBytes, release);
    await verifyModelFiles(modelDirectory, manifest, release);
    const names = await readdir(modelDirectory);
    const managedNames = new Set([...RELEASE_ASSET_NAMES, MARKER_FILE]);
    return {
      ...base,
      installationState: 'installed',
      artifactIntegrity: 'valid',
      inferenceAvailable: runtime.available,
      unmanagedFiles: names.filter((name) => !managedNames.has(name)),
    };
  } catch (error) {
    return {
      ...base,
      installationState: 'corrupt',
      artifactIntegrity: 'invalid',
      details: [errorMessage(error)],
    };
  }
}

export async function removeModel(options: ModelManagerOptions = {}): Promise<{
  modelDirectory: string;
  removed: boolean;
  preservedFiles: string[];
}> {
  const semanticSearch = await import('./semantic-search.js');
  const configuration = await semanticSearch.loadSemanticSearchConfiguration({
    environment: options.environment,
  });
  if (configuration.enabled) {
    throw new Error(
      `Cannot remove Qwen3 while Semantic Search is enabled in "${configuration.configPath}". Run \`nekosearch embeddings disable\` first; this preserves lexical search and existing embeddings.`,
    );
  }

  const release = options.release ?? PINNED_RELEASE;
  const modelDirectory = resolveModelDirectory(options);
  const initialStatus = await getModelStatus({
    ...options,
    modelDirectory,
    release,
  });
  if (initialStatus.installationState === 'not-installed') {
    return { modelDirectory, removed: false, preservedFiles: [] };
  }
  if (initialStatus.installationState === 'unmanaged') {
    throw new Error(
      `Refusing to remove files from an unmanaged model directory: ${modelDirectory}`,
    );
  }

  const lockDirectory = join(
    dirname(modelDirectory),
    `.${basename(modelDirectory)}${INSTALL_LOCK_DIRECTORY}`,
  );
  const releaseLock = await acquireInstallLock(lockDirectory);
  try {
    const status = await getModelStatus({
      ...options,
      modelDirectory,
      release,
    });
    if (status.installationState === 'not-installed') {
      return { modelDirectory, removed: false, preservedFiles: [] };
    }
    if (status.installationState === 'unmanaged') {
      throw new Error(
        `Refusing to remove files from an unmanaged model directory: ${modelDirectory}`,
      );
    }

    const marker = JSON.parse(
      (await readRegularFile(join(modelDirectory, MARKER_FILE), 4096)).toString(
        'utf8',
      ),
    ) as unknown;
    if (!isManagedMarker(marker, release)) {
      throw new Error(
        `The NekoSearch ownership marker is invalid at ${modelDirectory}`,
      );
    }

    const managedFiles = [...RELEASE_ASSET_NAMES, MARKER_FILE];
    for (const name of managedFiles) {
      const path = join(modelDirectory, name);
      try {
        const entry = await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(
            `Refusing to remove a non-regular managed path: ${path}`,
          );
        }
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }

    for (const name of managedFiles) {
      try {
        await unlink(join(modelDirectory, name));
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }

    const preservedFiles = await readdir(modelDirectory);
    if (preservedFiles.length === 0) {
      await rmdir(modelDirectory);
    }
    return { modelDirectory, removed: true, preservedFiles };
  } finally {
    await releaseLock();
  }
}

export function formatModelStatus(status: ModelStatus): string {
  const integrity = status.artifactIntegrity;
  const unavailableReason =
    status.details.join('; ') ||
    (status.installationState === 'not-installed'
      ? 'model is not installed'
      : status.installationState === 'unmanaged'
        ? 'the directory is not NekoSearch-managed'
        : 'model artifacts are not verified');
  const inference = status.inferenceAvailable
    ? `yes (${status.runtimeRequirement})`
    : `no (${unavailableReason})`;
  return [
    `Model: ${status.modelId}`,
    `Installation state: ${status.installationState}`,
    `Version: ${status.version}`,
    `Upstream revision: ${status.upstreamRevision}`,
    `Local model directory: ${status.modelDirectory}`,
    `Artifact integrity: ${integrity}`,
    `Runtime available: ${status.runtimeAvailable ? 'yes' : 'no'}`,
    `Runtime requirement: ${status.runtimeRequirement}`,
    `Available for inference: ${inference}`,
    ...(status.unmanagedFiles.length > 0
      ? [`Preserved unmanaged files: ${status.unmanagedFiles.join(', ')}`]
      : []),
  ].join('\n');
}

async function prepareStagingDirectory(
  stagedDirectory: string,
  release: ModelRelease,
): Promise<void> {
  if (!(await pathExists(stagedDirectory))) {
    await mkdir(stagedDirectory, { recursive: false, mode: 0o700 });
    await writeFile(
      join(stagedDirectory, MARKER_FILE),
      JSON.stringify({
        application: 'nekosearch',
        modelId: MODEL_ID,
        version: MODEL_VERSION,
        releaseTag: release.tag,
        manifestSha256: release.manifestSha256,
        state: 'installing',
      }),
      { flag: 'wx', mode: 0o600 },
    );
  }

  const stagedStat = await lstat(stagedDirectory);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    throw new Error(
      `The model staging path is not a regular directory: ${stagedDirectory}`,
    );
  }
  const marker = JSON.parse(
    (await readRegularFile(join(stagedDirectory, MARKER_FILE), 4096)).toString(
      'utf8',
    ),
  ) as Record<string, unknown>;
  if (
    marker.application !== 'nekosearch' ||
    marker.modelId !== MODEL_ID ||
    marker.version !== MODEL_VERSION ||
    marker.releaseTag !== release.tag ||
    marker.manifestSha256 !== release.manifestSha256 ||
    !['installing', 'complete'].includes(String(marker.state))
  ) {
    throw new Error(
      `The existing model staging directory is not NekoSearch-managed`,
    );
  }
  const existingNames = await readdir(stagedDirectory);
  const allowedNames = new Set([
    MARKER_FILE,
    ...RELEASE_ASSET_NAMES,
    ...RELEASE_ASSET_NAMES.map((name) => `${name}.part`),
  ]);
  const unexpected = existingNames.filter((name) => !allowedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected files in model staging directory: ${unexpected.join(', ')}`,
    );
  }
}

async function acquireInstallLock(
  lockDirectory: string,
): Promise<() => Promise<void>> {
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error(
        `Another model installation is in progress. If it was interrupted, remove the stale lock directory ${lockDirectory}`,
        { cause: error },
      );
    }
    throw error;
  }
  const token = randomUUID();
  try {
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ application: 'nekosearch', pid: process.pid, token }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    try {
      const owner = JSON.parse(
        await readFile(join(lockDirectory, 'owner.json'), 'utf8'),
      ) as { token?: string };
      if (owner.token === token) {
        await unlink(join(lockDirectory, 'owner.json'));
        await rmdir(lockDirectory);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  };
}

async function ensureStagingMarker(
  stagedDirectory: string,
  release: ModelRelease,
): Promise<void> {
  const markerPath = join(stagedDirectory, MARKER_FILE);
  const marker = JSON.parse(
    (await readRegularFile(markerPath, 4096)).toString('utf8'),
  ) as Record<string, unknown>;
  if (
    marker.application !== 'nekosearch' ||
    marker.modelId !== MODEL_ID ||
    marker.version !== MODEL_VERSION ||
    marker.releaseTag !== release.tag ||
    marker.manifestSha256 !== release.manifestSha256 ||
    !['installing', 'complete'].includes(String(marker.state))
  ) {
    throw new Error(`The model staging marker changed during installation`);
  }
}

async function downloadReleaseAsset(
  url: string,
  destination: string,
  expectedSize: number,
  expectedSha256: string,
  fetcher: typeof fetch,
  progress: (message: string) => void,
): Promise<void> {
  const partialPath = `${destination}.part`;
  let lastPercent = -1;
  let lastFailure: unknown;

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const currentSize = await regularFileSize(partialPath);
      const offset = currentSize <= expectedSize ? currentSize : 0;
      if (currentSize > expectedSize) await unlink(partialPath);
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
      const response = await fetcher(url, { headers });

      if (response.status === 416 && offset === expectedSize) {
        await response.body?.cancel();
        if (await fileMatchesDigest(partialPath, expectedSha256)) {
          await rename(partialPath, destination);
          return;
        }
        await unlink(partialPath);
        continue;
      }
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        throw new Error(
          `HTTP ${response.status} while downloading ${basename(destination)}`,
        );
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(
          `HTTP ${response.status} while downloading ${basename(destination)}`,
        );
      }

      let append = false;
      let downloadedBeforeResponse = 0;
      if (response.status === 206) {
        const range = response.headers.get('content-range');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range ?? '');
        if (
          offset === 0 ||
          !match ||
          Number(match[1]) !== offset ||
          Number(match[3]) !== expectedSize
        ) {
          await response.body.cancel();
          await unlinkIfPresent(partialPath);
          throw new Error(
            `Invalid byte range while resuming ${basename(destination)}`,
          );
        }
        append = true;
        downloadedBeforeResponse = offset;
      } else if (response.status !== 200) {
        await response.body.cancel();
        throw new Error(
          `Unexpected HTTP ${response.status} while downloading ${basename(destination)}`,
        );
      }

      const file = await open(partialPath, append ? 'a' : 'w', 0o600);
      let downloaded = downloadedBeforeResponse;
      try {
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          await file.writeFile(bytes);
          downloaded += bytes.byteLength;
          const percent = Math.min(
            100,
            Math.floor((downloaded / expectedSize) * 100),
          );
          if (percent !== lastPercent) {
            lastPercent = percent;
            progress(
              `${basename(destination)} ${percent}% (${formatBytes(downloaded)} / ${formatBytes(expectedSize)})`,
            );
          }
        }
      } finally {
        await file.close();
      }

      const actualSize = await regularFileSize(partialPath);
      if (actualSize < expectedSize) {
        throw new Error(
          `Download of ${basename(destination)} was interrupted at ${actualSize} bytes`,
        );
      }
      if (
        actualSize !== expectedSize ||
        !(await fileMatchesDigest(partialPath, expectedSha256))
      ) {
        await unlinkIfPresent(partialPath);
        throw new Error(`Integrity check failed for ${basename(destination)}`);
      }
      await rename(partialPath, destination);
      progress(
        `${basename(destination)} verified (${formatBytes(expectedSize)})`,
      );
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt === MAX_DOWNLOAD_ATTEMPTS) break;
      await delay(attempt * 250);
    }
  }

  throw new Error(
    `Could not download ${basename(destination)} after ${MAX_DOWNLOAD_ATTEMPTS} attempts: ${errorMessage(lastFailure)}`,
  );
}

function parseAndValidateManifest(
  bytes: Buffer,
  release: ModelRelease,
): ModelManifest {
  if (sha256(bytes) !== release.manifestSha256) {
    throw new Error(
      'Release manifest SHA-256 does not match the pinned release',
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Release manifest is not valid JSON', { cause: error });
  }
  if (!isRecord(manifest))
    throw new Error('Release manifest must be an object');
  const model = manifest.model;
  const tokenizer = manifest.tokenizer;
  const upstream = manifest.upstream;
  const releaseMetadata = manifest.release;
  const runtime = manifest.runtime;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.modelId !== MODEL_ID ||
    manifest.version !== MODEL_VERSION ||
    !isRecord(releaseMetadata) ||
    releaseMetadata.repository !== release.repository ||
    releaseMetadata.tag !== release.tag ||
    releaseMetadata.checksums !== CHECKSUMS_FILE ||
    !isRecord(upstream) ||
    upstream.repository !== UPSTREAM_REPOSITORY ||
    upstream.revision !== UPSTREAM_REVISION ||
    !isRecord(model) ||
    model.architecture !== 'Qwen3Model' ||
    model.format !== 'onnx' ||
    model.contextLength !== 32768 ||
    model.embeddingDimensions !==
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.embeddingDimensions ||
    model.pooling !== 'last_token' ||
    model.normalization !== 'l2' ||
    !isRecord(tokenizer) ||
    tokenizer.class !== 'Qwen2Tokenizer' ||
    tokenizer.algorithm !== 'BPE' ||
    !Array.isArray(tokenizer.files) ||
    tokenizer.files.length !== 2 ||
    tokenizer.files[0] !== 'tokenizer.json' ||
    tokenizer.files[1] !== 'tokenizer_config.json' ||
    tokenizer.paddingSide !== 'left' ||
    tokenizer.padToken !== '<|endoftext|>' ||
    tokenizer.eosToken !== '<|im_end|>' ||
    !isRecord(runtime) ||
    runtime.package !== '@huggingface/transformers' ||
    runtime.version !== TRANSFORMERS_VERSION ||
    runtime.onnxruntimeNodeVersion !== ONNX_RUNTIME_NODE_VERSION ||
    // Immutable release provenance records the environment used to validate the artifacts.
    runtime.nodeVersion !== '24.22.2' ||
    runtime.platform !== 'linux' ||
    runtime.architecture !== 'x64' ||
    runtime.task !== 'feature-extraction' ||
    runtime.device !== 'cpu' ||
    runtime.dtype !== 'q8' ||
    runtime.subfolder !== '' ||
    runtime.externalData !== false ||
    runtime.recommendedBatchSize !== 1 ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error(
      'Release manifest metadata does not match the pinned model',
    );
  }

  const artifacts = manifest.artifacts;
  if (artifacts.length !== ARTIFACT_NAMES.length) {
    throw new Error('Release manifest does not list the expected artifact set');
  }
  const parsedArtifacts: ModelArtifact[] = [];
  for (const [index, expectedName] of ARTIFACT_NAMES.entries()) {
    const entry: unknown = artifacts[index];
    const requiredForInference = INFERENCE_ARTIFACT_NAMES.some(
      (name) => name === expectedName,
    );
    if (
      !isRecord(entry) ||
      entry.name !== expectedName ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      (entry.sizeBytes as number) <= 0 ||
      entry.requiredForInference !== requiredForInference
    ) {
      throw new Error(
        `Release manifest contains an invalid artifact: ${expectedName}`,
      );
    }
    parsedArtifacts.push({
      name: expectedName,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes as number,
      requiredForInference,
    });
  }
  return {
    ...(manifest as unknown as Omit<ModelManifest, 'artifacts'>),
    artifacts: parsedArtifacts,
  };
}

function verifyChecksumIndex(
  checksumBytes: Buffer,
  manifest: ModelManifest,
  release: ModelRelease,
): void {
  if (sha256(checksumBytes) !== release.checksumsSha256) {
    throw new Error(
      'Release SHA256SUMS digest does not match the pinned release',
    );
  }
  const lines = checksumBytes.toString('utf8').trimEnd().split('\n');
  const expectedEntries = [
    ...manifest.artifacts.map(
      ({ name, sha256: digest }) => `${digest}  ${name}`,
    ),
    `${release.manifestSha256}  ${MANIFEST_FILE}`,
  ];
  if (
    lines.length !== expectedEntries.length ||
    lines.some((line, index) => line !== expectedEntries[index])
  ) {
    throw new Error('Release SHA256SUMS does not match its pinned manifest');
  }
}

async function verifyModelFiles(
  directory: string,
  manifest: ModelManifest,
  release: ModelRelease,
): Promise<void> {
  const manifestBytes = await readRegularFile(
    join(directory, MANIFEST_FILE),
    MAX_MANIFEST_BYTES,
  );
  const checksumBytes = await readRegularFile(
    join(directory, CHECKSUMS_FILE),
    MAX_CHECKSUMS_BYTES,
  );
  verifyChecksumIndex(checksumBytes, manifest, release);
  if (sha256(manifestBytes) !== release.manifestSha256) {
    throw new Error(
      'Release manifest SHA-256 does not match the pinned release',
    );
  }
  for (const artifact of manifest.artifacts) {
    if (
      !(await fileMatchesArtifact(join(directory, artifact.name), artifact))
    ) {
      throw new Error(`Artifact integrity check failed for ${artifact.name}`);
    }
  }
}

function getRuntimeHostProblem(): string | undefined {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    major < 24 ||
    (major === 24 && minor < 15)
  ) {
    return `Local Qwen3 inference requires Linux x64 with Node.js >=24.15.0. Current host: ${process.platform} ${process.arch}, Node.js ${process.versions.node}.`;
  }
  return undefined;
}

function isManagedMarker(value: unknown, release: ModelRelease): boolean {
  return (
    isRecord(value) &&
    value.application === 'nekosearch' &&
    value.modelId === MODEL_ID &&
    value.version === MODEL_VERSION &&
    value.releaseTag === release.tag &&
    value.manifestSha256 === release.manifestSha256
  );
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular file at ${path}`);
  }
  if (metadata.size > maximumBytes) {
    throw new Error(`File exceeds the permitted size at ${path}`);
  }
  return readFile(path);
}

async function fileMatchesArtifact(
  path: string,
  artifact: ModelArtifact,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size === artifact.sizeBytes &&
      (await fileDigest(path)) === artifact.sha256
    );
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function fileMatchesDigest(
  path: string,
  expectedDigest: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (await fileDigest(path)) === expectedDigest
    );
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function regularFileSize(path: string): Promise<number> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Expected a regular file at ${path}`);
    }
    return metadata.size;
  } catch (error) {
    if (isMissingPath(error)) return 0;
    throw error;
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
