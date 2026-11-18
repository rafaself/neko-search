#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import {
  DocumentationEmbeddingSpaceSchema,
  QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import {
  hybridSearchRanking,
  LEXICAL_RETRIEVAL_TOP_K,
  SEMANTIC_RETRIEVAL_TOP_K,
} from '@nestjs-docs/documentation-engine/retrieval/fusion/reciprocal-rank-fusion.js';
import { SemanticRetriever } from '@nestjs-docs/documentation-engine/retrieval/retrievers/semantic-retriever.js';
import {
  getUserCatalogDirectory,
  listCatalogIndexes,
} from '../../dist/apps/nekosearch/catalog.js';
import { createLocalQwen3EmbeddingGenerator } from '../../dist/apps/nekosearch/local-qwen3-embedding-generator.js';
import { getModelStatus } from '../../dist/apps/nekosearch/model-manager.js';
import { inspectTransformersRuntime } from '../../dist/apps/nekosearch/transformers-runtime.js';

const RESULT_LIMIT = 10;
const SNAPSHOT_VERSIONS = ['11', '12'];
const DATASET_VERSION = 'nestjs-hybrid-search-v2';
const DEFAULT_EMBEDDING_SAMPLE_SIZE = 24;
const cases = [
  {
    query: 'ExecutionContext',
    target: 'fundamentals/execution-context#executioncontext-class',
    group: 'exact class identifier',
    exactSymbol: true,
  },
  {
    query: 'HttpException',
    target: 'exception-filters',
    group: 'exact class identifier',
    exactSymbol: true,
  },
  {
    query: 'execution context class',
    target: 'fundamentals/execution-context#executioncontext-class',
    group: 'identifier wording',
  },
  {
    query: 'HTTP exception filter handling',
    target: 'exception-filters',
    group: 'identifier wording',
  },
  {
    query: 'StreamableFile',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'exact class identifier',
    exactSymbol: true,
  },
  {
    query: '@Injectable()',
    target: 'guards#role-based-authentication',
    group: 'decorator',
    exactSymbol: true,
  },
  {
    query: '@UseGuards()',
    target: 'guards#binding-guards',
    group: 'decorator',
    exactSymbol: true,
  },
  {
    query: '@OnEvent()',
    targetByVersion: {
      11: 'techniques/events#listening-to-events',
      12: 'application/events#listening-to-events',
    },
    group: 'decorator',
    exactSymbol: true,
  },
  {
    query: 'getClass()',
    target: 'fundamentals/execution-context#executioncontext-class',
    group: 'method',
    exactSymbol: true,
  },
  {
    query: 'setGlobalPrefix()',
    target: 'faq/global-prefix#global-prefix',
    group: 'method',
    exactSymbol: true,
  },
  {
    query: 'autoLoadEntities',
    targetByVersion: {
      11: 'techniques/database#auto-load-entities',
      12: 'data/mikroorm#load-entities-automatically',
    },
    group: 'configuration key',
    exactSymbol: true,
  },
  {
    query: 'forbidNonWhitelisted',
    targetByVersion: {
      11: 'techniques/validation#using-the-built-in-validationpipe',
      12: 'application/validation#using-the-built-in-validationpipe',
    },
    group: 'configuration key',
    exactSymbol: true,
  },
  {
    query: 'request scoped providers',
    target: 'fundamentals/injection-scopes',
    group: 'technical concept',
  },
  {
    query: 'custom parameter decorators',
    targetByVersion: {
      11: 'custom-decorators',
      12: 'application/validation#validating-custom-decorators',
    },
    group: 'technical concept',
  },
  {
    query: 'circular dependency forwardRef',
    target: 'fundamentals/circular-dependency',
    group: 'technical concept',
    exactSymbol: true,
  },
  {
    query: 'streamable file response headers',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'technical concept',
  },
  {
    query: 'HTTP request lifecycle',
    target: 'faq/request-lifecycle#request-lifecycle',
    group: 'technical concept',
  },
  {
    query: 'dynamic module configuration',
    target: 'fundamentals/dynamic-modules#module-configuration',
    group: 'technical concept',
  },
  {
    query: 'How can I stream a file from a controller?',
    targetByVersion: {
      11: 'techniques/streaming-files',
      12: 'http/file-upload',
    },
    group: 'natural language',
  },
  {
    query: 'Where do I register a global validation pipe?',
    targetByVersion: {
      11: 'pipes#global-scoped-pipes',
      12: 'pipes#global-scoped-pipes',
    },
    group: 'natural language',
  },
  {
    query: 'How can a guard access the current request user?',
    target: 'guards#authorization-guard',
    group: 'natural language',
  },
  {
    query: 'How can I make a provider request scoped?',
    target: 'fundamentals/injection-scopes',
    group: 'natural language',
  },
  {
    query: 'How do I resolve a circular dependency?',
    target: 'fundamentals/circular-dependency',
    group: 'natural language',
  },
  {
    query: 'How are middleware guards and interceptors ordered?',
    target: 'faq/request-lifecycle',
    group: 'natural language',
  },
  {
    query: 'middleware versus interceptor request order',
    target: 'faq/request-lifecycle',
    group: 'ambiguous terminology',
  },
  {
    query: 'guard versus middleware request handling',
    target: 'faq/request-lifecycle',
    group: 'ambiguous terminology',
  },
  {
    query: 'pipe versus interceptor execution order',
    target: 'faq/request-lifecycle',
    group: 'ambiguous terminology',
  },
  {
    query: 'exception filter versus interceptor lifecycle',
    target: 'faq/request-lifecycle',
    group: 'ambiguous terminology',
  },
  {
    query: 'request context versus application context',
    target: 'fundamentals/execution-context',
    group: 'ambiguous terminology',
  },
  {
    query: 'Como limitar um provedor ao ciclo de vida de uma requisição?',
    target: 'fundamentals/injection-scopes',
    group: 'Portuguese natural language',
    language: 'pt',
  },
  {
    query: 'Como registrar um pipe de validação global?',
    targetByVersion: {
      11: 'pipes#global-scoped-pipes',
      12: 'pipes#global-scoped-pipes',
    },
    group: 'Portuguese natural language',
    language: 'pt',
  },
  {
    query: 'Qual a diferença entre guard e middleware no ciclo da requisição?',
    target: 'faq/request-lifecycle',
    group: 'Portuguese ambiguous terminology',
    language: 'pt',
  },
];

const catalogRoot =
  process.env.NEKOSEARCH_EVALUATION_CATALOG_ROOT?.trim() ||
  getUserCatalogDirectory();
const sampleSize = positiveInteger(
  process.env.NEKOSEARCH_EVAL_EMBEDDING_SAMPLE_SIZE,
  DEFAULT_EMBEDDING_SAMPLE_SIZE,
);
const entries = await listCatalogIndexes({ catalogRoot });
const snapshots = SNAPSHOT_VERSIONS.map((version) => {
  const entry = entries.find(
    (candidate) =>
      candidate.source === 'nestjs' &&
      candidate.version === version &&
      candidate.status === 'installed',
  );
  if (!entry) {
    throw new Error(
      `Missing installed NestJS ${version} snapshot in ${catalogRoot}. Install nestjs@${version}, then run nekosearch embeddings build nestjs@${version}.`,
    );
  }
  const embeddingSpace = DocumentationEmbeddingSpaceSchema.safeParse(
    entry.manifest.embeddings,
  );
  if (
    !embeddingSpace.success ||
    !isDeepStrictEqual(
      embeddingSpace.data,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    )
  ) {
    throw new Error(
      `nestjs@${version} does not have the compatible Qwen3 embedding space. Run nekosearch embeddings build nestjs@${version}.`,
    );
  }
  const store = new SQLiteDocumentationStore(
    entry.databasePath,
    entry.manifest,
  );
  const corpus = DocumentationCorpusSchema.parse(
    JSON.parse(
      readFileSync(join(dirname(entry.databasePath), 'corpus.json'), 'utf8'),
    ),
  );
  return {
    entry,
    store,
    corpus,
    documentation: new DocumentationSearchService(store, entry.manifest),
    semanticRetriever: new SemanticRetriever(
      store,
      embeddingSpace.data,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    ),
  };
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Network access is disabled during search evaluation');
};
let peakRssBytes = process.memoryUsage().rss;
const rssSampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 25);
rssSampler.unref();

try {
  const modelStatus = await getModelStatus();
  if (
    modelStatus.installationState !== 'installed' ||
    modelStatus.artifactIntegrity !== 'valid' ||
    !modelStatus.inferenceAvailable
  ) {
    throw new Error(
      `A verified local Qwen3 installation and inference runtime are required: ${modelStatus.details.join('; ') || modelStatus.installationState}. Evaluation never downloads model files.`,
    );
  }
  const runtime = inspectTransformersRuntime();
  if (!runtime.available) throw new Error(runtime.detail);

  const relevanceRows = [];
  const baselineLatencies = [];
  for (const testCase of cases) {
    const startedAt = performance.now();
    for (const snapshot of snapshots) {
      const results = snapshot.documentation.search(
        testCase.query,
        LEXICAL_RETRIEVAL_TOP_K,
      );
      relevanceRows.push({
        query: testCase.query,
        group: testCase.group,
        exactSymbol: Boolean(testCase.exactSymbol),
        language: testCase.language ?? 'en',
        version: snapshot.entry.version,
        retriever: 'bm25',
        rank: relevantRank(
          results,
          targetFor(testCase, snapshot.entry.version),
        ),
      });
    }
    baselineLatencies.push(performance.now() - startedAt);
  }
  const baselineRssBytes = process.memoryUsage().rss;

  const generator = createLocalQwen3EmbeddingGenerator();
  const coldQueryStartedAt = performance.now();
  await generator.embedQuery('Model initialization measurement query');
  const modelInitializationAndFirstQueryMs =
    performance.now() - coldQueryStartedAt;
  const afterModelLoadRssBytes = process.memoryUsage().rss;
  const sampleTexts = snapshots
    .flatMap((snapshot) =>
      snapshot.corpus.documents.flatMap((document) =>
        document.chunks.map((chunk) => chunk.markdown),
      ),
    )
    .slice(0, sampleSize);
  const embeddingStartedAt = performance.now();
  await generator.embedDocuments(sampleTexts);
  const embeddingGenerationMs = performance.now() - embeddingStartedAt;
  const embeddingThroughput =
    sampleTexts.length / (embeddingGenerationMs / 1000);
  const afterEmbeddingSampleRssBytes = process.memoryUsage().rss;

  const hybridRanks = [];
  const hybridLatencies = [];
  for (const testCase of cases) {
    const startedAt = performance.now();
    const queryVector = await generator.embedQuery(testCase.query);
    for (const snapshot of snapshots) {
      const lexicalResults = snapshot.documentation.search(
        testCase.query,
        LEXICAL_RETRIEVAL_TOP_K,
      );
      const semanticResults = snapshot.semanticRetriever.search(
        queryVector,
        SEMANTIC_RETRIEVAL_TOP_K,
      );
      const fusedResults = hybridSearchRanking(
        testCase.query,
        lexicalResults,
        semanticResults,
        LEXICAL_RETRIEVAL_TOP_K,
      );
      hybridRanks.push({
        query: testCase.query,
        group: testCase.group,
        exactSymbol: Boolean(testCase.exactSymbol),
        language: testCase.language ?? 'en',
        version: snapshot.entry.version,
        retriever: 'hybrid',
        rank: relevantRank(
          fusedResults,
          targetFor(testCase, snapshot.entry.version),
        ),
      });
    }
    hybridLatencies.push(performance.now() - startedAt);
  }

  const bm25Rows = relevanceRows.filter((row) => row.retriever === 'bm25');
  const regressions = bm25Rows.flatMap((baseline, index) => {
    const hybrid = hybridRanks[index];
    if (!hybrid || !isRegression(baseline.rank, hybrid.rank)) return [];
    return [
      {
        query: baseline.query,
        group: baseline.group,
        version: baseline.version,
        exactSymbol: baseline.exactSymbol,
        bm25Rank: baseline.rank,
        hybridRank: hybrid.rank,
      },
    ];
  });
  const groups = [...new Set(cases.map(({ group }) => group))].sort();
  const allChunkCount = snapshots.reduce(
    (total, snapshot) => total + snapshot.entry.manifest.index.chunkCount,
    0,
  );
  const report = {
    benchmark: DATASET_VERSION,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      transformersJs: runtime.transformersVersion,
      onnxruntimeNode: runtime.onnxRuntimeNodeVersion,
      modelInitializationAndFirstQueryMs: round(
        modelInitializationAndFirstQueryMs,
      ),
      embeddingGeneration: {
        sampledDocuments: sampleTexts.length,
        totalSnapshotChunks: allChunkCount,
        elapsedMs: round(embeddingGenerationMs),
        documentsPerSecond: round(embeddingThroughput, 3),
      },
      memory: {
        bm25ProcessRssBytes: baselineRssBytes,
        afterModelLoadRssBytes,
        afterEmbeddingSampleRssBytes,
        peakObservedRssBytes: peakRssBytes,
        modelLoadRssDeltaBytes: afterModelLoadRssBytes - baselineRssBytes,
      },
    },
    dataset: {
      version: DATASET_VERSION,
      queryCount: cases.length,
      sourceQueryCount: relevanceRows.length,
      expectedVersions: SNAPSHOT_VERSIONS,
      snapshots: snapshots.map((snapshot) => ({
        selector: `nestjs@${snapshot.entry.version}`,
        revision: snapshot.entry.revision,
        documentCount: snapshot.entry.manifest.index.documentCount,
        chunkCount: snapshot.entry.manifest.index.chunkCount,
        embeddingSpace: snapshot.entry.manifest.embeddings,
      })),
      queryGroups: Object.fromEntries(
        groups.map((group) => [
          group,
          cases.filter((testCase) => testCase.group === group).length,
        ]),
      ),
    },
    metrics: {
      bm25: {
        quality: qualityMetrics(bm25Rows),
        latencyMs: latencyMetrics(baselineLatencies),
      },
      hybrid: {
        quality: qualityMetrics(hybridRanks),
        latencyMs: latencyMetrics(hybridLatencies),
      },
      byGroup: Object.fromEntries(
        groups.map((group) => [
          group,
          {
            queryCount: cases.filter((testCase) => testCase.group === group)
              .length,
            bm25: qualityMetrics(bm25Rows.filter((row) => row.group === group)),
            hybrid: qualityMetrics(
              hybridRanks.filter((row) => row.group === group),
            ),
          },
        ]),
      ),
      exactTechnicalSymbols: {
        queryCount: cases.filter(({ exactSymbol }) => exactSymbol).length,
        bm25: qualityMetrics(bm25Rows.filter((row) => row.exactSymbol)),
        hybrid: qualityMetrics(hybridRanks.filter((row) => row.exactSymbol)),
        regressions: regressions.filter((row) => row.exactSymbol),
      },
    },
    regressions,
    results: cases.map((testCase, index) => ({
      query: testCase.query,
      group: testCase.group,
      language: testCase.language ?? 'en',
      exactSymbol: Boolean(testCase.exactSymbol),
      expectedPath: SNAPSHOT_VERSIONS.map((version, versionIndex) => ({
        version,
        target: targetFor(testCase, version),
        bm25Rank:
          bm25Rows[index * SNAPSHOT_VERSIONS.length + versionIndex]?.rank ??
          null,
        hybridRank:
          hybridRanks[index * SNAPSHOT_VERSIONS.length + versionIndex]?.rank ??
          null,
      })),
    })),
    definitions: {
      relevantResult:
        'A result is relevant when its canonical URL path and fragment contain the case target; each case has one relevant target page.',
      recallAt5:
        'Binary recall over the single target page, averaged by case and snapshot.',
      mrrAt10:
        'Reciprocal rank of the first target page, zero when absent from the first 10.',
      ndcgAt10:
        'Discounted gain for the single target page at its first rank, zero when absent from the first 10.',
      latency:
        'End-to-end local retrieval per query across NestJS 11 and 12; hybrid includes one query embedding, both retrievers, and fusion. Model load is reported separately.',
      memory:
        'RSS values are process snapshots; peakObservedRssBytes is sampled every 25 ms during the run.',
      rrf: {
        k: 60,
        lexicalTopK: LEXICAL_RETRIEVAL_TOP_K,
        semanticTopK: SEMANTIC_RETRIEVAL_TOP_K,
        resultLimit: RESULT_LIMIT,
      },
      network:
        'fetch was blocked for the entire evaluation; model inference used local files only.',
    },
  };

  const outputPath = process.env.NEKOSEARCH_EVAL_OUTPUT?.trim();
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), output);
  process.stdout.write(output);
} finally {
  clearInterval(rssSampler);
  globalThis.fetch = originalFetch;
  for (const snapshot of snapshots) snapshot.store.close();
}

function targetFor(testCase, version) {
  const suffix = testCase.targetByVersion?.[version] ?? testCase.target;
  return version === '11' ? `/v11/${suffix}` : `/${suffix}`;
}

function relevantRank(results, target) {
  const index = results.findIndex((row) => {
    const url = new URL(row.canonicalUrl);
    return `${url.pathname}${url.hash}`.includes(target);
  });
  return index < 0 ? null : index + 1;
}

function qualityMetrics(rows) {
  const count = rows.length;
  if (count === 0) {
    return { queries: 0, recallAt5: 0, mrrAt10: 0, ndcgAt10: 0 };
  }
  const reciprocalRanks = rows.map(({ rank }) =>
    rank !== null && rank <= RESULT_LIMIT ? 1 / rank : 0,
  );
  return {
    queries: count,
    recallAt5: round(
      rows.filter((row) => row.rank !== null && row.rank <= 5).length / count,
      3,
    ),
    mrrAt10: round(
      reciprocalRanks.reduce((total, value) => total + value, 0) / count,
      3,
    ),
    ndcgAt10: round(
      rows.reduce(
        (total, { rank }) =>
          total +
          (rank !== null && rank <= RESULT_LIMIT ? 1 / Math.log2(rank + 1) : 0),
        0,
      ) / count,
      3,
    ),
  };
}

function latencyMetrics(values) {
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function isRegression(baselineRank, hybridRank) {
  return (
    baselineRank !== null && (hybridRank === null || hybridRank > baselineRank)
  );
}

function positiveInteger(rawValue, fallback) {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      'NEKOSEARCH_EVAL_EMBEDDING_SAMPLE_SIZE must be a positive integer',
    );
  }
  return parsed;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
