import { copyFile } from 'node:fs/promises';

const app = new URL('../../apps/nekosearch/', import.meta.url);
await copyFile(
  new URL('src/semantic-runtime-lock.json', app),
  new URL('dist/apps/nekosearch/semantic-runtime-lock.json', app),
);
