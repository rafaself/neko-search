import { z } from 'zod';
import {
  fetchDocsInputSchema,
  fetchDocsOutputSchema,
  searchDocsInputSchema,
  searchDocsOutputSchema,
} from '../../modules/documentation/mcp/contracts/documentation-tools.contract.js';

export const MAX_SEARCH_SOURCES = 5;
export const MAX_TOTAL_SEARCH_RESULTS = 10;
const MAX_SELECTOR_LENGTH = 256 + 1 + 64;

const selectorSchema = z
  .string()
  .min(1)
  .max(MAX_SELECTOR_LENGTH)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !containsControlCharacters(value))
  .describe(
    'Canonical documentation selector returned by list_docs, such as nestjs@12.',
  );

const sourceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacters(value));
const versionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !containsControlCharacters(value));
const revisionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacters(value));

const documentationSourceSchema = z.object({
  selector: selectorSchema,
  source: sourceSchema,
  version: versionSchema,
  revision: revisionSchema,
});

export const catalogListDocsInputSchema = z.strictObject({});

export const catalogListDocsOutputSchema = z.object({
  sources: z.array(documentationSourceSchema),
});

export const catalogSearchDocsInputSchema = z
  .strictObject({
    query: searchDocsInputSchema.shape.query,
    sources: z
      .array(selectorSchema)
      .min(1)
      .max(MAX_SEARCH_SOURCES)
      .describe(
        `Canonical selectors from list_docs; choose 1 to ${MAX_SEARCH_SOURCES} sources.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOTAL_SEARCH_RESULTS)
      .optional()
      .describe(
        `Maximum results across all source groups (1 to ${MAX_TOTAL_SEARCH_RESULTS}; defaults to ${MAX_TOTAL_SEARCH_RESULTS}).`,
      ),
  })
  .superRefine(({ sources }, context) => {
    if (new Set(sources).size !== sources.length) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Each source selector may appear only once.',
      });
    }
  });

const catalogSearchGroupSchema = documentationSourceSchema.extend({
  results: z.array(searchDocsOutputSchema.shape.results.element),
});

export const catalogSearchDocsOutputSchema = z.object({
  groups: z.array(catalogSearchGroupSchema),
  totalResults: z.number().int().min(0).max(MAX_TOTAL_SEARCH_RESULTS),
});

export const catalogFetchDocsInputSchema = fetchDocsInputSchema.extend({
  selector: selectorSchema.describe(
    'One canonical source selector returned by list_docs or search_docs.',
  ),
});

export const catalogFetchDocsOutputSchema = fetchDocsOutputSchema.extend({
  selector: selectorSchema,
  source: sourceSchema,
  version: versionSchema,
  revision: revisionSchema,
});

export type CatalogDocumentationSource = z.infer<
  typeof documentationSourceSchema
>;
export type CatalogSearchDocsInput = z.infer<
  typeof catalogSearchDocsInputSchema
>;
export type CatalogSearchDocsOutput = z.infer<
  typeof catalogSearchDocsOutputSchema
>;
export type CatalogFetchDocsInput = z.infer<typeof catalogFetchDocsInputSchema>;

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
