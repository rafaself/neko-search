import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DocumentationCorpus,
  DocumentationSnapshot,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import { parseMarkdown } from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import { normalizeAndChunkDocument } from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import { MAX_FETCH_DOCUMENT_CHARS } from '@nestjs-docs/documentation-engine/retrieval/search.constants.js';
import { paginateDocumentation } from '@nestjs-docs/documentation-engine/retrieval/document-page.js';
import { buildDocumentationSnapshot } from '../../../../apps/docs-indexer/src/services/build-documentation-snapshot.js';
import { fetchDocumentation } from '../../../../src/modules/documentation/mcp/documentation-tool-handlers.js';
import { fetchDocsOutputSchema } from '../../../../src/modules/documentation/mcp/contracts/documentation-tools.contract.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';

describe('resolved internal documentation links', () => {
  let root: string;
  let outputDirectory: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'resolved-documentation-links-'));
    outputDirectory = join(root, 'snapshot');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves same-page, relative, canonical, and section links without rewriting Markdown', async () => {
    await build(buildSnapshot('revision-one', 'Target details'));
    const corpus = await loadCorpus();
    const origin = corpus.documents.find(
      (document) => document.source.path === 'content/origin.md',
    )!;
    const target = corpus.documents.find(
      (document) => document.source.path === 'content/target.md',
    )!;
    const service = openService();
    try {
      const result = fetchDocumentation(service, {
        documentId: origin.id,
      });
      const output = fetchDocsOutputSchema.parse(result.structuredContent);
      const localAnchor = output.references.find(
        (reference) => reference.href === '#local-anchor',
      );
      expect(localAnchor?.documentId).toBe(origin.id);
      expect(typeof localAnchor?.sectionId).toBe('string');
      const relativeHeading = output.references.find(
        (reference) => reference.href === './target.md#target-details',
      );
      expect(relativeHeading?.documentId).toBe(target.id);
      expect(typeof relativeHeading?.sectionId).toBe('string');
      const pageOnly = output.references.find(
        (reference) => reference.href === 'https://docs.example.test/target',
      );
      expect(pageOnly).toEqual({
        href: 'https://docs.example.test/target',
        documentId: target.id,
      });
      const canonicalHeading = output.references.find(
        (reference) =>
          reference.href === 'https://docs.example.test/target#target-details',
      );
      expect(canonicalHeading?.documentId).toBe(target.id);
      expect(typeof canonicalHeading?.sectionId).toBe('string');
      expect(output.references).toHaveLength(4);
      expect(
        output.sections.map((section) => section.markdown).join('\n'),
      ).toContain('[Missing](./target.md#missing-anchor)');
      expect(
        output.sections.map((section) => section.markdown).join('\n'),
      ).toContain('[External](https://external.example.test/guide)');

      for (const reference of output.references) {
        expect(
          service.fetchDocument(reference.documentId, reference.sectionId),
        ).not.toBeNull();
      }
    } finally {
      service.close();
    }
  });

  it('recomputes references after a target heading changes on an incremental build', async () => {
    const firstSnapshot = buildSnapshot('revision-one', 'Target details');
    await build(firstSnapshot, 'clean');
    const previous = await loadCorpus();
    const originId = previous.documents.find(
      (document) => document.source.path === 'content/origin.md',
    )!.id;
    const initialService = openService();
    const initialReferences =
      initialService.fetchDocument(originId)!.references;
    const initialHeadingReference = initialReferences.find(
      (reference) => reference.href === './target.md#target-details',
    );
    expect(typeof initialHeadingReference?.sectionId).toBe('string');
    initialService.close();

    await build(
      buildSnapshot('revision-two', 'Renamed details'),
      'incremental',
    );
    const nextCorpus = await loadCorpus();
    const origin = nextCorpus.documents.find(
      (document) => document.source.path === 'content/origin.md',
    )!;
    expect(origin.source.contentHash).toBe(
      previous.documents.find((document) => document.id === originId)!.source
        .contentHash,
    );
    expect(
      nextCorpus.documents
        .find((document) => document.id === originId)!
        .chunks.flatMap((chunk) => chunk.references)
        .some((reference) => reference?.href === './target.md#target-details'),
    ).toBe(false);

    const updatedService = openService();
    try {
      const references = updatedService.fetchDocument(originId)!.references;
      expect(
        references.some((reference) =>
          reference.href.includes('#target-details'),
        ),
      ).toBe(false);
      expect(
        references.some(
          (reference) =>
            reference.href === 'https://docs.example.test/target' &&
            reference.sectionId === undefined,
        ),
      ).toBe(true);
    } finally {
      updatedService.close();
    }
  });

  it('returns only complete link occurrences visible on the current fetch page and caps references', () => {
    const documentId = 'docs:large-page';
    const canonicalUrl = 'https://docs.example.test/large#long';
    const framing = `\n\n## Long\nSource: ${canonicalUrl}\n\n`;
    const pageCapacity = MAX_FETCH_DOCUMENT_CHARS - framing.length;
    const splitSyntax = '[Split](#split)';
    const splitStart = pageCapacity - 4;
    const laterStart = pageCapacity + 20;
    const markdown = `${'x'.repeat(splitStart)}${splitSyntax}${'y'.repeat(100)}`;
    const row = {
      chunkId: 'chunk-1',
      title: 'Large page',
      headingPath: 'Long',
      canonicalUrl,
      sourceRevision: 'revision-one',
      markdown,
      references: [
        {
          href: '#early',
          startOffset: 1,
          endOffset: 4,
          documentId: 'docs:early',
          sectionId: 'docs:early:section',
        },
        {
          href: '#split',
          startOffset: splitStart,
          endOffset: splitStart + splitSyntax.length,
          documentId: 'docs:split',
          sectionId: 'docs:split:section',
        },
        {
          href: '#later',
          startOffset: laterStart,
          endOffset: laterStart + 6,
          documentId: 'docs:later',
        },
      ],
    };
    const firstPage = paginateDocumentation(
      { id: 'docs', version: '1' },
      documentId,
      [row],
    );
    expect(firstPage.references).toEqual([
      {
        href: '#early',
        documentId: 'docs:early',
        sectionId: 'docs:early:section',
      },
    ]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = paginateDocumentation(
      { id: 'docs', version: '1' },
      documentId,
      [row],
      undefined,
      firstPage.nextCursor,
    );
    expect(secondPage.references).toEqual([
      { href: '#later', documentId: 'docs:later' },
    ]);

    const manyReferences = Array.from({ length: 101 }, (_, index) => ({
      href: `#link-${index}`,
      startOffset: 1 + index * 3,
      endOffset: 3 + index * 3,
      documentId: `docs:target-${index}`,
    }));
    const bounded = paginateDocumentation(
      { id: 'docs', version: '1' },
      documentId,
      [{ ...row, markdown: 'x'.repeat(1000), references: manyReferences }],
    );
    expect(bounded.references).toHaveLength(100);
  });

  async function build(
    snapshot: DocumentationSnapshot,
    mode: 'clean' | 'incremental' = 'incremental',
  ) {
    return buildDocumentationSnapshot({
      identity: { id: 'internal-guides', version: '1' },
      snapshot,
      transformDocument: transformDocument,
      transformerVersion: 1,
      outputDirectory,
      mode,
    });
  }

  function buildSnapshot(
    revision: string,
    targetHeading: string,
  ): DocumentationSnapshot {
    const source = {
      kind: 'local' as const,
      root: '/synthetic/guides',
      revision,
    };
    const documents: SourceDocument[] = [
      {
        id: 'origin',
        version: '1',
        path: 'content/origin.md',
        canonicalUrl: 'https://docs.example.test/origin',
        sourceLocation: 'file:///synthetic/guides/content/origin.md',
        markdown: [
          '# Origin',
          '',
          '## Local anchor',
          '',
          '[Same page](#local-anchor)',
          '',
          '[Relative heading](./target.md#target-details)',
          '',
          '[Page only](https://docs.example.test/target)',
          '',
          '[Canonical section](https://docs.example.test/target#target-details)',
          '',
          '[Missing](./target.md#missing-anchor)',
          '',
          '[External](https://external.example.test/guide)',
        ].join('\n'),
      },
      {
        id: 'target',
        version: '1',
        path: 'content/target.md',
        canonicalUrl: 'https://docs.example.test/target',
        sourceLocation: 'file:///synthetic/guides/content/target.md',
        markdown: `# Target\n\n## ${targetHeading}\n\nTarget page content is fetchable offline.`,
      },
    ];
    return { version: '1', source, documents };
  }

  async function loadCorpus(): Promise<DocumentationCorpus> {
    return JSON.parse(
      await readFile(join(outputDirectory, 'corpus.json'), 'utf8'),
    ) as DocumentationCorpus;
  }

  function openService(): TestDocumentationSearchService {
    return new TestDocumentationSearchService(
      join(outputDirectory, 'index.sqlite'),
      '1',
    );
  }
});

function transformDocument(
  file: SourceDocument,
  source: DocumentationSnapshot['source'],
  maxChunkChars: number,
) {
  return normalizeAndChunkDocument(
    file,
    source,
    parseMarkdown(file.markdown, { path: file.path }),
    {
      identity: { id: 'internal-guides', version: file.version },
      maxChunkChars,
    },
  );
}
