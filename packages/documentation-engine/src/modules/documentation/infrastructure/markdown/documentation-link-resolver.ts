import { posix } from 'node:path';
import type {
  DocumentationCorpus,
  DocumentationChunk,
  NormalizedDocument,
} from '../../domain/documentation.types.js';
import { DocumentationCorpusSchema } from '../../domain/documentation.schemas.js';
import { parseMarkdown } from './markdown-parser.js';

export const DOCUMENTATION_LINK_RESOLVER_VERSION = 1;

type PageLookup = Map<string, NormalizedDocument[]>;

/** Resolve links only against pages already present in the local snapshot. */
export function resolveInternalDocumentationLinks(
  input: DocumentationCorpus,
): DocumentationCorpus {
  const corpus = DocumentationCorpusSchema.parse(input);
  const byCanonicalUrl: PageLookup = new Map();
  const bySourcePath: PageLookup = new Map();
  for (const document of corpus.documents) {
    addLookup(
      byCanonicalUrl,
      canonicalPageKey(document.canonicalUrl),
      document,
    );
    addLookup(bySourcePath, document.source.path, document);
  }

  const documents = corpus.documents.map((document) => {
    const documentDefinitions = parseMarkdown(document.markdown, {
      path: document.source.path,
    }).linkDefinitions;
    const chunks = document.chunks.map((chunk) => {
      const parsed = parseMarkdown(chunk.markdown, {
        path: document.source.path,
        linkDefinitions: documentDefinitions,
      });
      const references = parsed.links.flatMap((link) => {
        if (
          link.kind !== 'link' ||
          link.startOffset === undefined ||
          link.endOffset === undefined ||
          link.endOffset > chunk.markdown.length
        ) {
          return [];
        }
        const target = resolveTarget(
          document,
          link.url,
          byCanonicalUrl,
          bySourcePath,
        );
        if (!target) return [];
        return [
          {
            href: link.url,
            startOffset: link.startOffset,
            endOffset: link.endOffset,
            documentId: target.document.id,
            ...(target.sectionId ? { sectionId: target.sectionId } : {}),
          },
        ];
      });
      return { ...chunk, references };
    });
    return { ...document, chunks };
  });

  return DocumentationCorpusSchema.parse({
    formatVersion: 2,
    version: corpus.version,
    source: corpus.source,
    documents,
  });
}

function resolveTarget(
  source: NormalizedDocument,
  href: string,
  byCanonicalUrl: PageLookup,
  bySourcePath: PageLookup,
): { document: NormalizedDocument; sectionId?: string } | undefined {
  let destination: URL;
  try {
    destination = new URL(href, source.canonicalUrl);
  } catch {
    return undefined;
  }

  const candidates = new Set<NormalizedDocument>();
  const canonicalMatches = byCanonicalUrl.get(
    canonicalPageKey(destination.href),
  );
  for (const match of canonicalMatches ?? []) candidates.add(match);

  const isAbsoluteUrl =
    /^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('//');
  if (!isAbsoluteUrl) {
    for (const path of sourcePathCandidates(source.source.path, href)) {
      for (const match of bySourcePath.get(path) ?? []) candidates.add(match);
    }
  }

  if (candidates.size !== 1) return undefined;
  const document = candidates.values().next().value;
  if (!document) return undefined;
  const fragment = destination.hash.slice(1);
  if (!fragment) return { document };

  let slug: string;
  try {
    slug = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  if (!document.headings.some((heading) => heading.slug === slug)) {
    // An explicit but missing anchor must never degrade into a page fetch.
    return undefined;
  }
  const targetChunk =
    document.chunks.find((chunk) => chunk.headingPath.at(-1)?.slug === slug) ??
    document.chunks.find((chunk) =>
      chunk.headingPath.some((heading) => heading.slug === slug),
    );
  return targetChunk ? { document, sectionId: targetChunk.id } : undefined;
}

function sourcePathCandidates(sourcePath: string, href: string): string[] {
  const rawPath = href.split(/[?#]/u, 1)[0] ?? '';
  if (!rawPath) return [];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return [];
  }
  if (!decodedPath || decodedPath === '/') return [];

  const sourceRoot = sourcePath.split('/')[0];
  const stripped = decodedPath.replace(/^\/+/, '');
  let resolvedPath: string;
  if (
    sourceRoot &&
    (stripped === sourceRoot || stripped.startsWith(`${sourceRoot}/`))
  ) {
    resolvedPath = posix.normalize(stripped);
  } else if (rawPath.startsWith('/')) {
    const hasMarkdownExtension = /\.mdx?$/iu.test(stripped);
    if (!hasMarkdownExtension) {
      resolvedPath = posix.join(sourceRoot ?? '', stripped);
    } else {
      resolvedPath = posix.normalize(stripped);
    }
  } else {
    resolvedPath = posix.normalize(
      posix.join(posix.dirname(sourcePath), decodedPath),
    );
  }
  if (resolvedPath === '..' || resolvedPath.startsWith('../')) return [];

  if (/\.mdx?$/iu.test(resolvedPath)) return [resolvedPath];
  return [
    `${resolvedPath}.md`,
    `${resolvedPath}.mdx`,
    `${resolvedPath}/index.md`,
    `${resolvedPath}/index.mdx`,
  ];
}

function canonicalPageKey(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/u, '') || '/';
  return `${url.origin}${path}`;
}

function addLookup(
  lookup: PageLookup,
  key: string,
  document: NormalizedDocument,
): void {
  const documents = lookup.get(key) ?? [];
  documents.push(document);
  lookup.set(key, documents);
}

export type DocumentationLinkTarget = NonNullable<
  DocumentationChunk['references']
>[number];
