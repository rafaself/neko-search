import { Inject, Injectable } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import type { DocumentationReader } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { DOCUMENTATION_READER } from '@nestjs-docs/documentation-engine/application/contracts/documentation.tokens.js';
import {
  fetchDocsInputSchema,
  fetchDocsOutputSchema,
  searchDocsInputSchema,
  searchDocsOutputSchema,
  type FetchDocsInput,
  type SearchDocsInput,
} from './contracts/documentation-tools.contract.js';
import {
  fetchDocumentation,
  searchDocumentation,
} from './documentation-tool-handlers.js';

@Injectable()
export class DocumentationTools {
  constructor(
    @Inject(DOCUMENTATION_READER)
    private readonly documentation: DocumentationReader,
  ) {}

  @Tool({
    name: 'search_docs',
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
  })
  searchDocs({ query, limit }: SearchDocsInput) {
    return searchDocumentation(this.documentation, { query, limit });
  }

  @Tool({
    name: 'fetch_docs',
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
  })
  fetchDocs(input: FetchDocsInput) {
    return fetchDocumentation(this.documentation, input);
  }
}
