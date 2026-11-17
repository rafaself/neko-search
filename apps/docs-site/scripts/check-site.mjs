import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(
  new URL('../.vitepress/dist/', import.meta.url),
);
const base = process.env.DOCS_SITE_BASE || '/';
assert(
  base.startsWith('/') && base.endsWith('/'),
  'DOCS_SITE_BASE must start and end with /.',
);
const localOrigin = 'https://docs.invalid';
const documents = new Map();

async function collectHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectHtml(path);
    else if (entry.name.endsWith('.html')) {
      documents.set(path, await readFile(path, 'utf8'));
    }
  }
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    );
}

async function resolveTarget(pathname) {
  const path = resolve(
    outputDirectory,
    decodeURIComponent(pathname.slice(base.length)),
  );
  const localPath = relative(outputDirectory, path);
  assert(
    !localPath.startsWith(`..${sep}`) && localPath !== '..',
    'Link escapes site output.',
  );
  const candidates = pathname.endsWith('/')
    ? [join(path, 'index.html')]
    : [path];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('Target file does not exist.');
}

await collectHtml(outputDirectory);
assert(
  documents.size >= 18,
  'Expected the complete NekoSearch documentation build.',
);
const idsByDocument = new Map(
  [...documents].map(([path, html]) => [
    path,
    new Set(
      [...html.matchAll(/\bid=(['"])(.*?)\1/gu)].map((match) =>
        decodeHtml(match[2]),
      ),
    ),
  ]),
);
const failures = [];
let checked = 0;
for (const [path, html] of documents) {
  const pageUrl = new URL(
    `${base}${relative(outputDirectory, path).split(sep).join('/')}`,
    localOrigin,
  );
  for (const match of html.matchAll(/\b(?:href|src|poster)=(['"])(.*?)\1/gu)) {
    const raw = decodeHtml(match[2]);
    if (!raw || /^(?:mailto:|tel:|data:|javascript:)/iu.test(raw)) continue;
    try {
      const url = new URL(raw, pageUrl);
      if (url.origin !== localOrigin) continue;
      assert(url.pathname.startsWith(base), 'Link omits the deployment base.');
      const target = await resolveTarget(url.pathname);
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (fragment && documents.has(target)) {
        assert(
          idsByDocument.get(target).has(fragment),
          `Missing fragment #${fragment}.`,
        );
      }
      checked++;
    } catch (error) {
      failures.push(
        `${relative(outputDirectory, path)} → ${raw}: ${error.message}`,
      );
    }
  }
}
assert.equal(
  failures.length,
  0,
  `Broken local links/assets:\n${failures.join('\n')}`,
);
console.log(
  `Checked ${documents.size} HTML pages and ${checked} local links/assets (base ${base}).`,
);
