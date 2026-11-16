import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import { fetchDocumentation } from '../../modules/documentation/mcp/documentation-tool-handlers.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../shared/config/package-metadata.js';
import {
  catalogFetchDocsInputSchema,
  catalogFetchDocsOutputSchema,
  catalogListDocsInputSchema,
  catalogListDocsOutputSchema,
  catalogSearchDocsInputSchema,
  catalogSearchDocsOutputSchema,
  MAX_SEARCH_SOURCES,
  MAX_TOTAL_SEARCH_RESULTS,
  type CatalogDocumentationSource,
  type CatalogSearchDocsInput,
  type CatalogSearchDocsOutput,
} from './catalog-contract.js';
import {
  listCatalogIndexes,
  type DocumentationCatalogEntry,
} from './catalog.js';

const serverInstructions =
  'Call list_docs to discover the documentation selectors available in this session. Search one or more exact selectors with search_docs, then pass a result group selector and document ID to fetch_docs. Pass a result chunkId as fetch_docs sectionId when you want that section. Results are grouped by source. Cite the returned source URL and revision.';

interface CatalogSearchRuntime {
  entry: DocumentationCatalogEntry;
  documentation: DocumentationSearchService;
  store: SQLiteDocumentationStore;
}

export interface SearchableCatalogRuntime {
  entry: Pick<DocumentationCatalogEntry, 'source' | 'version' | 'revision'>;
  documentation: Pick<DocumentationSearchService, 'search'>;
}

type CatalogSearchHit = DocumentationSearchResult;

export async function serve(): Promise<void> {
  const entries = await listCatalogIndexes();
  const runtimes: CatalogSearchRuntime[] = [];
  let runtimesBySelector: Map<string, CatalogSearchRuntime>;
  try {
    for (const entry of entries) {
      const store = new SQLiteDocumentationStore(
        entry.databasePath,
        entry.manifest,
      );
      runtimes.push({
        entry,
        store,
        documentation: new DocumentationSearchService(store, entry.manifest),
      });
    }
    runtimesBySelector = indexRuntimesBySelector(runtimes);
  } catch (error) {
    for (const runtime of runtimes) runtime.store.onModuleDestroy();
    throw error;
  }

  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      instructions: serverInstructions,
    },
  );
  server.registerTool(
    'list_docs',
    {
      description:
        'Lists documentation available to this serve session. Returns only each canonical selector, source, version, and revision; use a selector with search_docs or fetch_docs.',
      inputSchema: catalogListDocsInputSchema,
      outputSchema: catalogListDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    () =>
      runTool('list_docs', () =>
        listCatalogDocumentation(runtimesBySelector.values()),
      ),
  );
  server.registerTool(
    'search_docs',
    {
      description: `Searches only the 1 to ${MAX_SEARCH_SOURCES} exact selectors in sources. Get selectors from list_docs. Results are grouped by selector and preserve each index's ranking; limit caps the total response at ${MAX_TOTAL_SEARCH_RESULTS} hits across all groups.`,
      inputSchema: catalogSearchDocsInputSchema,
      outputSchema: catalogSearchDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    (input) =>
      runTool('search_docs', () =>
        searchCatalogDocumentation(runtimesBySelector, input),
      ),
  );
  server.registerTool(
    'fetch_docs',
    {
      description:
        'Fetches a document from one exact selector returned by list_docs or a search result group. Pass the documentId and optional sectionId from that group; use the result chunkId as sectionId. The structured response includes up to 100 resolved internal links fully visible on this page, each with offline-fetchable target IDs. External and unresolved links remain in the Markdown. Use a returned cursor to continue a truncated excerpt.',
      inputSchema: catalogFetchDocsInputSchema,
      outputSchema: catalogFetchDocsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    (input) =>
      runTool('fetch_docs', () => {
        const runtime = findRuntime(runtimesBySelector, input.selector);
        const result = fetchDocumentation(runtime.documentation, {
          documentId: input.documentId,
          sectionId: input.sectionId,
          cursor: input.cursor,
        });
        return {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            ...documentationSource(runtime),
          },
        };
      }),
  );

  const stores = runtimes.map((runtime) => runtime.store);
  process.once('exit', () => closeStores(stores));
  process.once('SIGINT', () => shutdown(server, stores, 130));
  process.once('SIGTERM', () => shutdown(server, stores, 143));

  await server.connect(new StdioServerTransport());
  process.stderr.write('NekoSearch MCP server ready on stdio\n');
}

export function searchCatalogDocumentation(
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  input: CatalogSearchDocsInput,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: CatalogSearchDocsOutput;
} {
  // Resolve every selector before querying any index. Unknown selectors never
  // broaden the request to the rest of the catalog.
  const selectedRuntimes = resolveRequestedRuntimes(
    runtimesBySelector,
    input.sources,
  );
  const totalBudget = input.limit ?? MAX_TOTAL_SEARCH_RESULTS;
  const rankedResults = selectedRuntimes.map((runtime) =>
    runtime.documentation.search(input.query, totalBudget),
  );
  const resultsBySource = selectedRuntimes.map(() => [] as CatalogSearchHit[]);

  let totalResults = 0;
  for (let rank = 0; totalResults < totalBudget; rank += 1) {
    let foundAtRank = false;
    for (
      let sourceIndex = 0;
      sourceIndex < rankedResults.length;
      sourceIndex += 1
    ) {
      const hit = rankedResults[sourceIndex]?.[rank];
      if (!hit) continue;
      resultsBySource[sourceIndex]?.push(hit);
      totalResults += 1;
      foundAtRank = true;
      if (totalResults === totalBudget) break;
    }
    if (!foundAtRank) break;
  }

  const groups = selectedRuntimes.map((runtime, index) => ({
    ...documentationSource(runtime),
    results: resultsBySource[index] ?? [],
  }));
  const structuredContent: CatalogSearchDocsOutput = {
    groups,
    totalResults,
  };
  return {
    content: [{ type: 'text', text: formatSearchGroups(groups, totalResults) }],
    structuredContent,
  };
}

export function listCatalogDocumentation(
  runtimes: Iterable<SearchableCatalogRuntime>,
): {
  content: [{ type: 'text'; text: string }];
  structuredContent: { sources: CatalogDocumentationSource[] };
} {
  const sources = [...runtimes].map(documentationSource);
  const text = sources.length
    ? [
        'Documentation available in this session:',
        ...sources.map(
          ({ selector, source, version, revision }) =>
            `- ${selector} (source: ${source}, version: ${version}, revision: ${revision})`,
        ),
      ].join('\n')
    : 'No documentation sources are available in this session.';
  return {
    content: [{ type: 'text', text }],
    structuredContent: { sources },
  };
}

function formatSearchGroups(
  groups: CatalogSearchDocsOutput['groups'],
  totalResults: number,
): string {
  if (totalResults === 0) {
    return `No matching documentation found in ${groups.map(({ selector }) => selector).join(', ')}.`;
  }
  return groups
    .map(({ selector, revision, results }) => {
      const header = `## ${selector}\nRevision: ${revision}`;
      if (results.length === 0)
        return `${header}\nNo matching documentation found.`;
      const formattedResults = results.map((hit, index) =>
        [
          `### ${index + 1}. ${hit.title}`,
          `Document ID: ${hit.documentId}`,
          `Section ID: ${hit.chunkId}`,
          `Source revision: ${hit.sourceRevision}`,
          `Source: ${hit.canonicalUrl}`,
          `Excerpt: ${hit.excerpt}`,
        ].join('\n'),
      );
      return [header, ...formattedResults].join('\n\n');
    })
    .join('\n\n');
}

function resolveRequestedRuntimes(
  runtimesBySelector: ReadonlyMap<string, SearchableCatalogRuntime>,
  selectors: string[],
): SearchableCatalogRuntime[] {
  const duplicateSelectors = selectors.filter(
    (selector, index) => selectors.indexOf(selector) !== index,
  );
  if (duplicateSelectors.length > 0) {
    throw new Error(
      `Source selectors may appear only once: ${[...new Set(duplicateSelectors)].join(', ')}.`,
    );
  }

  const unknownSelectors = selectors.filter(
    (selector) => !runtimesBySelector.has(selector),
  );
  if (unknownSelectors.length > 0) {
    throw new Error(
      `Unknown documentation selector${unknownSelectors.length === 1 ? '' : 's'}: ${unknownSelectors.join(', ')}. Call list_docs and use exact selectors from its response.`,
    );
  }
  return selectors.map((selector) => runtimesBySelector.get(selector)!);
}

function indexRuntimesBySelector(
  runtimes: CatalogSearchRuntime[],
): Map<string, CatalogSearchRuntime> {
  const indexed = new Map<string, CatalogSearchRuntime>();
  for (const runtime of runtimes) {
    const selector = selectorFor(runtime.entry);
    if (indexed.has(selector)) {
      throw new Error(
        `Catalog contains more than one documentation source for selector ${selector}.`,
      );
    }
    indexed.set(selector, runtime);
  }
  return indexed;
}

function findRuntime(
  runtimesBySelector: Map<string, CatalogSearchRuntime>,
  selector: string,
): CatalogSearchRuntime {
  const runtime = runtimesBySelector.get(selector);
  if (!runtime) {
    throw new Error(
      `Unknown documentation selector: ${selector}. Call list_docs and use an exact selector from its response.`,
    );
  }
  return runtime;
}

function documentationSource(
  runtime: SearchableCatalogRuntime,
): CatalogDocumentationSource {
  const { source, version, revision } = runtime.entry;
  return {
    selector: selectorFor(runtime.entry),
    source,
    version,
    revision,
  };
}

function selectorFor(
  entry: Pick<DocumentationCatalogEntry, 'source' | 'version'>,
): string {
  return `${entry.source}@${entry.version}`;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function runTool<T>(name: string, handler: () => T): T {
  const startedAt = Date.now();
  try {
    const result = handler();
    if (process.env.DEBUG === '1')
      process.stderr.write(
        `MCP tool ${name} success in ${Date.now() - startedAt} ms\n`,
      );
    return result;
  } catch (error) {
    if (process.env.DEBUG === '1')
      process.stderr.write(
        `MCP tool ${name} failure in ${Date.now() - startedAt} ms: ${formatError(error)}\n`,
      );
    throw error;
  }
}

function shutdown(
  server: McpServer,
  stores: SQLiteDocumentationStore[],
  exitCode: number,
): void {
  process.exitCode = exitCode;
  void server
    .close()
    .catch((error: unknown) => {
      process.stderr.write(`MCP shutdown failed: ${formatError(error)}\n`);
    })
    .finally(() => closeStores(stores));
}

function closeStores(stores: SQLiteDocumentationStore[]): void {
  for (const store of stores) store.onModuleDestroy();
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
