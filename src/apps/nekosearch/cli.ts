#!/usr/bin/env node
import 'reflect-metadata';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.js';
import {
  addSnapshot,
  formatCatalogList,
  listCatalogIndexes,
} from './catalog.js';

const [command, ...arguments_] = process.argv.slice(2);

if (command === 'build') {
  runBuildCommand(arguments_);
} else if (
  command === 'mcp' &&
  arguments_[0] === 'configure' &&
  arguments_[1] === 'codex' &&
  (arguments_.length === 2 ||
    (arguments_.length === 3 && arguments_[2] === '--force'))
) {
  runCodexConfigureCommand(arguments_.length === 3);
} else if (command === 'serve' && arguments_.length === 0) {
  serve().catch((error: unknown) => {
    process.stderr.write(`nekosearch serve failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
} else if (command === 'list' && arguments_.length === 0) {
  listCatalogIndexes()
    .then((entries) => process.stdout.write(`${formatCatalogList(entries)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch list failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    });
} else if (command === 'outdated' && arguments_.length <= 1) {
  void import('./remote-snapshots.js')
    .then(({ checkOutdatedSnapshots }) => checkOutdatedSnapshots(arguments_[0]))
    .then((results) => {
      process.stdout.write(
        [
          [
            'SOURCE',
            'VERSION',
            'STATUS',
            'INSTALLED',
            'UPSTREAM',
            'DETAIL',
          ].join('\t'),
          ...results.map((result) =>
            [
              result.source,
              result.version,
              result.status,
              result.installedRevision,
              result.upstreamRevision ?? '',
              result.error ?? '',
            ].join('\t'),
          ),
        ].join('\n') + '\n',
      );
      if (results.some((result) => result.status === 'check failed')) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch outdated failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
} else if (
  command === 'add' &&
  arguments_.length === 2 &&
  arguments_[0] === '--from' &&
  arguments_[1]
) {
  addSnapshot(arguments_[1])
    .then((entry) =>
      process.stdout.write(
        `Added ${entry.source}@${entry.version} revision ${entry.revision} (installed)\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch add failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    });
} else if (
  command === 'add' &&
  arguments_.length === 1 &&
  /^nestjs@(11|12)$/u.test(arguments_[0] ?? '')
) {
  runRemoteSnapshotCommand('add', arguments_[0] ?? '');
} else if (
  command === 'update' &&
  arguments_.length === 1 &&
  /^nestjs@(11|12)$/u.test(arguments_[0] ?? '')
) {
  runRemoteSnapshotCommand('update', arguments_[0] ?? '');
} else {
  process.stderr.write(
    command === '--help' || command === '-h' || command === undefined
      ? usage()
      : `Unknown command: ${command}\n${usage()}`,
  );
  if (command !== '--help' && command !== '-h' && command !== undefined)
    process.exitCode = 2;
}

function runRemoteSnapshotCommand(
  operation: 'add' | 'update',
  target: string,
): void {
  const separator = target.lastIndexOf('@');
  const source = target.slice(0, separator);
  const version = target.slice(separator + 1);
  void import('./remote-snapshots.js')
    .then(({ installRemoteSnapshot }) =>
      installRemoteSnapshot(source, version, operation),
    )
    .then(({ entry, changed }) => {
      const verb =
        operation === 'add' ? 'Added' : changed ? 'Updated' : 'Already current';
      process.stdout.write(
        `${verb} ${entry.source}@${entry.version} revision ${entry.revision} (installed)\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch ${operation} failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function runBuildCommand(arguments_: string[]): void {
  void import('./build.js')
    .then(({ buildLocalSnapshot }) => buildLocalSnapshot(arguments_))
    .then((summary) => {
      process.stderr.write(
        [
          `Built documentation ${summary.id}@${summary.version}`,
          `  source revision: ${summary.sourceRevision}`,
          `  documents: ${summary.documentCount}`,
          `  chunks: ${summary.chunkCount}`,
          `  output: ${summary.outputDirectory}`,
        ].join('\n') + '\n',
      );
      for (const diagnostic of summary.diagnostics) {
        process.stderr.write(
          `Warning ${diagnostic.path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n`,
        );
      }
      if (summary.cleanupWarning) {
        process.stderr.write(`Warning ${summary.cleanupWarning}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch build failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    });
}

function runCodexConfigureCommand(force: boolean): void {
  const nekosearchCommand = resolve(
    process.argv[1] ?? fileURLToPath(import.meta.url),
  );
  void import('./codex-config.js')
    .then(({ configureCodexMcp }) =>
      configureCodexMcp({ nekosearchCommand, force }),
    )
    .then((result) => {
      const message = {
        added: 'Configured Codex MCP server nekosearch.',
        replaced: 'Replaced Codex MCP server nekosearch.',
        unchanged: 'Codex MCP server nekosearch is already configured.',
      }[result];
      process.stdout.write(`${message}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch mcp configure codex failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function usage(): string {
  return [
    'NekoSearch is a local, read-only MCP server for documentation snapshots.',
    '',
    'Usage:',
    '  nekosearch build <docs-dir> --id <source@version> --output <snapshot-dir> [--clean]',
    '  nekosearch serve',
    '  nekosearch list',
    '  nekosearch outdated [<source@version>]',
    '  nekosearch add --from <snapshot-dir>',
    '  nekosearch add nestjs@<major>       (curated example: 11 or 12)',
    '  nekosearch update nestjs@<major>    (curated example: 11 or 12)',
    '  nekosearch mcp configure codex [--force]',
    '',
    'Network access:',
    '  build, list, add --from, serve, and mcp configure codex use local files.',
    '  add/update nestjs@<major> fetch official documentation over HTTPS.',
    '  outdated resolves tracked upstream refs over HTTPS without downloading docs.',
    '  serve is stdio-only, offline, and read-only.',
    '  add/update store validated SQLite snapshots in the user data directory.',
    '',
  ].join('\n');
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
