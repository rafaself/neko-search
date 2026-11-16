import { z } from 'zod';
import {
  fetchDocsInputSchema,
  fetchDocsOutputSchema,
  searchDocsInputSchema,
  searchDocsOutputSchema,
} from '../../modules/documentation/mcp/contracts/documentation-tools.contract.js';

const catalogSourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacters(value));
const catalogVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !containsControlCharacters(value));

export const catalogSearchDocsInputSchema = searchDocsInputSchema.extend({
  source: catalogSourceSchema.describe(
    'Source identity returned by nekosearch list or a previous search_docs result.',
  ),
  version: catalogVersionSchema.describe(
    'Documentation version returned by nekosearch list or search_docs.',
  ),
});

export const catalogFetchDocsInputSchema = fetchDocsInputSchema.extend({
  source: catalogSourceSchema.describe(
    'Source identity returned by search_docs for this document.',
  ),
  version: catalogVersionSchema.describe(
    'Documentation version returned by search_docs for this document.',
  ),
});

const catalogSearchResultSchema =
  searchDocsOutputSchema.shape.results.element.extend({
    source: catalogSourceSchema,
    version: catalogVersionSchema,
  });

export const catalogSearchDocsOutputSchema = searchDocsOutputSchema.extend({
  source: catalogSourceSchema,
  version: catalogVersionSchema,
  revision: z.string(),
  results: z.array(catalogSearchResultSchema),
});

export const catalogFetchDocsOutputSchema = fetchDocsOutputSchema.extend({
  source: catalogSourceSchema,
  version: catalogVersionSchema,
  revision: z.string(),
});

export type CatalogSearchDocsInput = z.infer<
  typeof catalogSearchDocsInputSchema
>;
export type CatalogFetchDocsInput = z.infer<typeof catalogFetchDocsInputSchema>;

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
