import { fileURLToPath } from 'node:url';
import { defineConfig, type HeadConfig } from 'vitepress';
import { sidebar } from './navigation';

const base = process.env.DOCS_SITE_BASE || '/';
if (
  !base.startsWith('/') ||
  !base.endsWith('/') ||
  base.includes('//') ||
  base.includes('..') ||
  /[?#\\\s]/u.test(base)
) {
  throw new Error(
    'DOCS_SITE_BASE must be an absolute path with a trailing slash.',
  );
}

const configuredOrigin =
  process.env.DOCS_SITE_URL || 'https://nekosearch.pages.dev';
const origin = configuredOrigin ? new URL(configuredOrigin) : undefined;
if (
  origin &&
  (!['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash)
) {
  throw new Error(
    'DOCS_SITE_URL must be an HTTP(S) origin; set paths with DOCS_SITE_BASE.',
  );
}
const siteUrl = origin ? new URL(base, origin).href : undefined;

export default defineConfig({
  title: 'NekoSearch',
  description:
    'Build searchable documentation snapshots and give AI coding agents structured, source-scoped access through MCP.',
  lang: 'en-US',
  base,
  cleanUrls: true,
  srcDir: './docs',
  appearance: 'dark',
  lastUpdated: true,
  ignoreDeadLinks: false,
  vite: {
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}nekosearch.png` }],
    ['meta', { name: 'theme-color', content: '#e0234e' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'NekoSearch' }],
  ],
  sitemap: siteUrl ? { hostname: siteUrl } : undefined,
  transformHead({ pageData, title, description }) {
    const head: HeadConfig[] = [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
    ];
    if (siteUrl && pageData.relativePath !== '404.md') {
      const path = pageData.relativePath
        .replace(/index\.md$/u, '')
        .replace(/\.md$/u, '');
      const url = new URL(path, siteUrl).href;
      head.push(
        ['link', { rel: 'canonical', href: url }],
        ['meta', { property: 'og:url', content: url }],
        [
          'meta',
          {
            property: 'og:image',
            content: new URL('nekosearch.png', siteUrl).href,
          },
        ],
        [
          'meta',
          {
            property: 'og:image:alt',
            content: 'The NekoSearch cat reading a book',
          },
        ],
      );
    }
    return head;
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  themeConfig: {
    logo: { src: '/nekosearch.png', alt: 'NekoSearch' },
    nav: [
      {
        text: 'Getting Started',
        link: '/',
        activeMatch: '^/$|/getting-started/',
      },
      {
        text: 'Guides',
        link: '/guides/documentation-sources',
        activeMatch: '/guides/',
      },
      { text: 'CLI', link: '/cli/overview', activeMatch: '/cli/' },
      { text: 'MCP', link: '/mcp/overview', activeMatch: '/mcp/' },
      {
        text: 'Architecture',
        link: '/architecture/overview',
        activeMatch: '/architecture/',
      },
    ],
    sidebar,
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/rafaself/nekosearch' },
    ],
    editLink: {
      pattern:
        'https://github.com/rafaself/nekosearch/edit/main/apps/docs-site/docs/:path',
      text: 'Edit this page on GitHub',
    },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    lastUpdated: {
      text: 'Last updated',
      formatOptions: { dateStyle: 'medium' },
    },
    footer: {
      message: 'Local documentation. Explicit sources. Better context.',
      copyright: 'NekoSearch · Released under the MIT License',
    },
  },
});
