import { accessSync, constants, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { loadDocumentationIndexManifest } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-index-manifest.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import {
  fetchDocsInputSchema,
  fetchDocsOutputSchema,
  searchDocsInputSchema,
  searchDocsOutputSchema,
} from '../../modules/documentation/mcp/contracts/documentation-tools.contract.js';
import {
  fetchDocumentation,
  searchDocumentation,
} from '../../modules/documentation/mcp/documentation-tool-handlers.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../shared/config/package-metadata.js';

const serverInstructions =
  'This server reads one validated documentation index, fixed at startup. Use search_docs, then fetch_docs with a returned document ID for more detail. Continue truncated results with the same ID and cursor. Ground answers in returned content and cite its source URL and revision.';

export async function serve(): Promise<void> {
  const databasePath = process.env.DOCUMENTATION_INDEX_PATH;
  if (!databasePath) {
    throw new Error(
      'DOCUMENTATION_INDEX_PATH is required and must name an existing SQLite index',
    );
  }
  assertReadableIndexFile(databasePath);

  const manifestPath = process.env.DOCUMENTATION_INDEX_MANIFEST_PATH;
  const indexManifest = loadDocumentationIndexManifest(
    databasePath,
    manifestPath,
  );
  const store = new SQLiteDocumentationStore(databasePath, indexManifest);
  const documentation = new DocumentationSearchService(store, indexManifest);
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
        'Searches the documentation index selected when this server starts. Returns ranked section excerpts, document IDs, and source URLs.',
      inputSchema: searchDocsInputSchema,
      outputSchema: searchDocsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool('search_docs', () => searchDocumentation(documentation, input)),
  );
  server.registerTool(
    'fetch_docs',
    {
      description:
        'Fetch a document or a section identified by search_docs. Use the returned cursor with the same document and section to continue a truncated excerpt.',
      inputSchema: fetchDocsInputSchema,
      outputSchema: fetchDocsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool('fetch_docs', () => fetchDocumentation(documentation, input)),
  );

  process.once('exit', () => store.onModuleDestroy());
  process.once('SIGINT', () => shutdown(server, store, 130));
  process.once('SIGTERM', () => shutdown(server, store, 143));

  await server.connect(new StdioServerTransport());
  process.stderr.write('NekoSearch MCP server ready on stdio\n');
}

function assertReadableIndexFile(databasePath: string): void {
  try {
    if (!statSync(databasePath).isFile()) {
      throw new Error('path is not a regular file');
    }
    accessSync(databasePath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Documentation index is missing or unreadable: "${databasePath}"`,
      { cause: error },
    );
  }
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
  store: SQLiteDocumentationStore,
  exitCode: number,
): void {
  process.exitCode = exitCode;
  void server
    .close()
    .catch((error: unknown) => {
      process.stderr.write(`MCP shutdown failed: ${formatError(error)}\n`);
    })
    .finally(() => store.onModuleDestroy());
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
