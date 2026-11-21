import { copyFile, cp } from 'node:fs/promises';

const app = new URL('../../apps/nekosearch/', import.meta.url);
await Promise.all([
  copyFile(
    new URL('src/semantic-runtime-lock.json', app),
    new URL('dist/apps/nekosearch/semantic-runtime-lock.json', app),
  ),
  cp(
    new URL('src/ui/assets/', app),
    new URL('dist/apps/nekosearch/ui/assets/', app),
    { recursive: true },
  ),
]);
