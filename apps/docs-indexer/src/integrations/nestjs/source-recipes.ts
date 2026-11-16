import type { DocumentationDocumentTransformer } from '@nestjs-docs/documentation-engine/application/contracts/documentation-transformer.contract.js';
import {
  NESTJS_DOCUMENTATION_REPOSITORY,
  type NestJsDocumentationVersion,
} from './version/documentation-version.js';
import {
  NESTJS_DOCUMENTATION_TRANSFORMER_VERSION,
  transformNestJsDocument,
} from './nestjs-documentation-transformer.js';

const SITE = 'https://docs.nestjs.com';

export interface NestJsDocumentationRecipe {
  version: NestJsDocumentationVersion;
  repository: string;
  ref: { kind: 'tag' | 'branch'; name: string };
  contentDirectory: 'content';
  canonicalRoot: string;
  selection:
    | { kind: 'tracked-markdown' }
    | {
        kind: 'navigation';
        navigationPath: string;
        aliasesPath: string;
        majorCheck: { path: string; from: number; to: number };
      };
  transformDocument: DocumentationDocumentTransformer;
  transformerVersion: number;
}

/**
 * Curated official source definitions. The v11 tag and v12 master content tree
 * were verified in the upstream NestJS docs repository on 2026-11-16.
 * Every install resolves the configured ref to a commit first and then reads
 * only files from that commit. There is deliberately no default-branch fallback.
 */
export const NESTJS_DOCUMENTATION_RECIPES: Record<
  NestJsDocumentationVersion,
  NestJsDocumentationRecipe
> = {
  '11': {
    version: '11',
    repository: NESTJS_DOCUMENTATION_REPOSITORY,
    ref: { kind: 'tag', name: '11.0.0' },
    contentDirectory: 'content',
    canonicalRoot: `${SITE}/v11`,
    selection: { kind: 'tracked-markdown' },
    transformDocument: transformNestJsDocument,
    transformerVersion: NESTJS_DOCUMENTATION_TRANSFORMER_VERSION,
  },
  '12': {
    version: '12',
    repository: NESTJS_DOCUMENTATION_REPOSITORY,
    ref: { kind: 'branch', name: 'master' },
    contentDirectory: 'content',
    canonicalRoot: SITE,
    selection: {
      kind: 'navigation',
      navigationPath: 'src/app/shared/nav/nav-items.ts',
      aliasesPath: 'tools/generate-llms-txt.ts',
      majorCheck: {
        path: 'content/migration.md',
        from: 11,
        to: 12,
      },
    },
    transformDocument: transformNestJsDocument,
    transformerVersion: NESTJS_DOCUMENTATION_TRANSFORMER_VERSION,
  },
};

export function getNestJsDocumentationRecipe(
  version: NestJsDocumentationVersion,
): NestJsDocumentationRecipe {
  return NESTJS_DOCUMENTATION_RECIPES[version];
}
