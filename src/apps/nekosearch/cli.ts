#!/usr/bin/env node
import 'reflect-metadata';
import { serve } from './serve.js';
import {
  addSnapshot,
  formatCatalogList,
  listCatalogIndexes,
} from './catalog.js';

const [command, ...arguments_] = process.argv.slice(2);

if (command === 'serve' && arguments_.length === 0) {
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

function usage(): string {
  return [
    'Usage:',
    '  nekosearch serve',
    '  nekosearch list',
    '  nekosearch add --from <snapshot-dir>',
    '  nekosearch add nestjs@<major>',
    '  nekosearch update nestjs@<major>',
    '',
  ].join('\n');
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
