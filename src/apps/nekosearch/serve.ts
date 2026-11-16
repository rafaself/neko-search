import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import {
  fetchDocumentation,
  searchDocumentation,
} from '../../modules/documentation/mcp/documentation-tool-handlers.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../shared/config/package-metadata.js';
import {
  catalogFetchDocsInputSchema,
  catalogFetchDocsOutputSchema,
  catalogSearchDocsInputSchema,
  catalogSearchDocsOutputSchema,
} from './catalog-contract.js';
import {
  listCatalogIndexes,
  type DocumentationCatalogEntry,
} from './catalog.js';

const serverInstructions =
  'Use nekosearch list to see available documentation sources and versions. Search one source and version at a time with search_docs, then pass the returned source and version with a document ID to fetch_docs. Results from different indexes are never combined. Cite the returned source URL and revision.';

interface CatalogSearchRuntime {
  entry: DocumentationCatalogEntry;
  documentation: DocumentationSearchService;
  store: SQLiteDocumentationStore;
}

export async function serve(): Promise<void> {
  const entries = await listCatalogIndexes();
  const runtimes: CatalogSearchRuntime[] = [];
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
    'search_docs',
    {
      description:
        'Searches exactly one documentation source and version. Choose source and version from nekosearch list. Each result includes those selectors so fetch_docs can use the same index.',
      inputSchema: catalogSearchDocsInputSchema,
      outputSchema: catalogSearchDocsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool('search_docs', () => {
        const runtime = findRuntime(runtimes, input.source, input.version);
        const result = searchDocumentation(runtime.documentation, input);
        return {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            source: runtime.entry.source,
            version: runtime.entry.version,
            revision: runtime.entry.revision,
            results: result.structuredContent.results.map((hit) => ({
              ...hit,
              source: runtime.entry.source,
              version: runtime.entry.version,
            })),
          },
        };
      }),
  );
  server.registerTool(
    'fetch_docs',
    {
      description:
        'Fetches a document from the exact source and version returned by search_docs. Pass its source, version, document ID, and optional section ID/cursor.',
      inputSchema: catalogFetchDocsInputSchema,
      outputSchema: catalogFetchDocsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool('fetch_docs', () => {
        const runtime = findRuntime(runtimes, input.source, input.version);
        const result = fetchDocumentation(runtime.documentation, {
          documentId: input.documentId,
          sectionId: input.sectionId,
          cursor: input.cursor,
        });
        return {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            source: runtime.entry.source,
            version: runtime.entry.version,
            revision: runtime.entry.revision,
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

function findRuntime(
  runtimes: CatalogSearchRuntime[],
  source: string,
  version: string,
): CatalogSearchRuntime {
  const runtime = runtimes.find(
    (candidate) =>
      candidate.entry.source === source && candidate.entry.version === version,
  );
  if (!runtime) {
    throw new Error(
      `No documentation index is registered for ${source}@${version}`,
    );
  }
  return runtime;
}

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
