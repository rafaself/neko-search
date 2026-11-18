import type { NestJsDocumentationVersion } from '../sources/nestjs/version/documentation-version.js';

export function documentationCorpusPath(
  version: NestJsDocumentationVersion,
): string {
  return `data/documentation-v${version}.json`;
}
