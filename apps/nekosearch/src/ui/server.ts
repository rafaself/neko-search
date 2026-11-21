import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readCatalogOverview, snapshotIdentity } from '../catalog.js';
import {
  CURATED_REMOTE_SNAPSHOT_RECIPES,
  getSnapshotTrackingState,
} from '../remote-snapshots.js';
import { dashboardJobRequestSchema } from './job-contract.js';
import { createDashboardJobs } from './jobs.js';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const ASSETS = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/dashboard.css', 'dashboard.css', 'text/css; charset=utf-8'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript; charset=utf-8'],
] as const;

export async function runDashboard(): Promise<void> {
  const assets = new Map<string, { type: string; body: Buffer }>(
    await Promise.all(
      ASSETS.map(async ([route, file, type]) => {
        const body = await readFile(
          new URL(`./assets/${file}`, import.meta.url),
        );
        return [route, { type, body }] as const;
      }),
    ),
  );
  const jobs = createDashboardJobs();
  const token = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${token}`);

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        process.stderr.write(
          `NekoSearch dashboard request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (response.headersSent) response.destroy();
        else
          json(response, 500, {
            error:
              'The dashboard request failed. See the terminal for details.',
          });
      });
    },
  );
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The dashboard did not bind to a TCP port');
  const origin = new URL(`http://${LOOPBACK}:${address.port}`);
  process.stdout.write(`Open NekoSearch: ${origin.href}#token=${token}\n`);

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (request.headers.host !== origin.host) {
      json(response, 403, { error: 'Invalid dashboard host.' });
      return;
    }

    const path = request.url ?? '';
    const asset = assets.get(path);
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.body);
      return;
    }
    if (!path.startsWith('/api/')) {
      json(response, 404, { error: 'Page not found.' });
      return;
    }

    const provided = Buffer.from(request.headers.authorization ?? '');
    if (
      provided.length !== authorization.length ||
      !timingSafeEqual(provided, authorization)
    ) {
      json(response, 401, {
        error: 'Open the dashboard using the link printed by NekoSearch.',
      });
      return;
    }
    if (request.method === 'GET' && path === '/api/catalog') {
      const { readable, entries, errors } = await readCatalogOverview();
      json(response, 200, {
        readable,
        errors,
        curatedSources: CURATED_REMOTE_SNAPSHOT_RECIPES.map(
          ({ selector }) => selector,
        ),
        entries: entries.map((entry) => ({
          selector: `${entry.source}@${entry.version}`,
          snapshotKey: snapshotIdentity(entry).directoryKey,
          revision: entry.revision,
          status: entry.status,
          tracking: getSnapshotTrackingState(entry),
          documentCount: entry.manifest.index.documentCount,
        })),
      });
      return;
    }
    if (request.method === 'GET' && path.startsWith('/api/jobs/')) {
      const job = jobs.get(path.slice('/api/jobs/'.length));
      if (job) json(response, 200, job);
      else json(response, 404, { error: 'This job is no longer available.' });
      return;
    }
    if (request.method === 'POST' && path === '/api/jobs') {
      if (request.headers.origin !== origin.origin) {
        json(response, 403, { error: 'Invalid dashboard origin.' });
        return;
      }
      const input = await readJobRequest(request, response);
      if (!input) return;
      const job = jobs.start(input);
      if (!job) {
        json(response, 409, {
          error: 'Another documentation operation is running.',
        });
        return;
      }
      response.setHeader('Location', `/api/jobs/${job.id}`);
      json(response, 202, job);
      return;
    }
    json(response, 404, { error: 'Route not found.' });
  }
}

async function readJobRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (
    request.headers['content-type']?.split(';')[0]?.trim() !==
    'application/json'
  ) {
    json(response, 415, { error: 'Send the operation as application/json.' });
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      response.setHeader('Connection', 'close');
      json(response, 413, { error: 'The operation request is too large.' });
      return;
    }
    chunks.push(chunk);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    json(response, 400, {
      error: 'The operation request contains invalid JSON.',
    });
    return;
  }
  const parsed = dashboardJobRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  json(response, 400, {
    error:
      'Invalid documentation operation. Use a source@version selector and an absolute path for folder imports.',
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
