import type { DocumentationReader } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { DEFAULT_SEARCH_RESULT_LIMIT } from '@nestjs-docs/documentation-engine/retrieval/search.constants.js';
import type {
  FetchDocsInput,
  SearchDocsInput,
} from './contracts/documentation-tools.contract.js';
import {
  presentFetchedDocumentation,
  presentSearchResults,
} from './presenters/documentation.presenter.js';

export function searchDocumentation(
  documentation: DocumentationReader,
  { query, limit }: SearchDocsInput,
) {
  const results = documentation.search(
    query,
    limit ?? DEFAULT_SEARCH_RESULT_LIMIT,
  );
  return presentSearchResults(results, documentation.documentation);
}

export function fetchDocumentation(
  documentation: DocumentationReader,
  { documentId, sectionId, cursor }: FetchDocsInput,
) {
  return presentFetchedDocumentation({
    documentId,
    sectionId,
    cursor,
    documentationId: documentation.documentation.id,
    document: documentation.fetchDocument(documentId, sectionId, cursor),
    documentationVersion: documentation.documentation.version,
  });
}
