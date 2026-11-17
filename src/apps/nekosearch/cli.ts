#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from './serve.js';
import {
  addSnapshot,
  formatCatalogList,
  listCatalogIndexes,
  removeSnapshot,
} from './catalog.js';
import { parseStatusArguments, renderStatus } from './status.js';

const [command, ...arguments_] = process.argv.slice(2);

if (command === 'setup' && arguments_.length === 0) {
  void import('./setup.js')
    .then(({ runSetup }) => runSetup())
    .then((exitCode) => {
      if (exitCode !== 0) process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch setup failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    });
} else if (command === 'build') {
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
} else if (command === 'status') {
  runStatusCommand(arguments_);
} else if (command === 'remove' && arguments_.length === 1 && arguments_[0]) {
  runRemoveCommand(arguments_[0]);
} else if (command === 'add' && arguments_.includes('--github')) {
  runGitHubSnapshotCommand(arguments_);
} else if (
  command === 'add' &&
  arguments_.length === 4 &&
  arguments_[0] === '--dir' &&
  arguments_[1] &&
  arguments_[2] === '--id' &&
  arguments_[3]
) {
  runLocalSnapshotCommand(arguments_[1], arguments_[3]);
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

function runStatusCommand(arguments_: string[]): void {
  let parsed: ReturnType<typeof parseStatusArguments>;
  try {
    parsed = parseStatusArguments(arguments_);
  } catch (error) {
    process.stderr.write(
      `nekosearch status failed: ${errorMessage(error)}\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }
  void renderStatus(parsed)
    .then(({ text, exitCode }) => {
      process.stdout.write(text);
      if (exitCode !== 0) process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch status failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    });
}

function runRemoveCommand(selector: string): void {
  void removeSnapshot(selector)
    .then(({ entry, cleanupWarning }) => {
      process.stdout.write(
        `Removed ${entry.source}@${entry.version} revision ${entry.revision} (installed)\n`,
      );
      if (cleanupWarning) {
        process.stderr.write(`Warning: ${cleanupWarning}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`nekosearch remove failed: ${formatError(error)}\n`);
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

function runLocalSnapshotCommand(
  inputDirectory: string,
  selector: string,
): void {
  void import('./local-snapshots.js')
    .then(({ installLocalSnapshot }) =>
      installLocalSnapshot(inputDirectory, selector),
    )
    .then((entry) =>
      process.stdout.write(
        `Added ${entry.source}@${entry.version} revision ${entry.revision} (installed)\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch add --dir failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function runGitHubSnapshotCommand(arguments_: string[]): void {
  let values: { github?: string; ref?: string; path?: string; id?: string };
  try {
    ({ values } = parseArgs({
      args: arguments_,
      options: {
        github: { type: 'string' },
        ref: { type: 'string' },
        path: { type: 'string' },
        id: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(
      `nekosearch add --github failed: ${errorMessage(error)}\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }
  if (!values.github || !values.ref || !values.path || !values.id) {
    process.stderr.write(
      `nekosearch add --github requires --github <repository-url> --ref <ref> --path <docs-dir> --id <source@version>\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }

  void import('./github-snapshots.js')
    .then(({ installGitHubSnapshot }) =>
      installGitHubSnapshot(
        values.github!,
        values.ref!,
        values.path!,
        values.id!,
      ),
    )
    .then((entry) =>
      process.stdout.write(
        `Added ${entry.source}@${entry.version} revision ${entry.revision} (installed)\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch add --github failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function runCodexConfigureCommand(force: boolean): void {
  void import('./codex-config.js')
    .then(async ({ configureCodexMcp }) => {
      const { createNekosearchStdioCommand } = await import('./mcp-command.js');
      return configureCodexMcp({
        serverCommand: createNekosearchStdioCommand(
          fileURLToPath(import.meta.url),
        ),
        force,
      });
    })
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
    '  nekosearch setup                   (interactive first-run setup)',
    '  nekosearch build <docs-dir> --id <source@version> --output <snapshot-dir> [--clean]',
    '  nekosearch serve',
    '  nekosearch list',
    '  nekosearch status [<source@version>] [--check-upstream]',
    '  nekosearch remove <source@version>',
    '  nekosearch add --dir <docs-dir> --id <source@version> (offline local build and install)',
    '  nekosearch add --github <repository-url> --ref <ref> --path <docs-dir> --id <source@version>',
    '  nekosearch add --from <snapshot-dir>',
    '  nekosearch add nestjs@<major>       (curated example: 11 or 12)',
    '  nekosearch update nestjs@<major>    (curated example: 11 or 12)',
    '  nekosearch mcp configure codex [--force]',
    '',
    '  status defaults to a local overview; a selector reads only that snapshot.',
    '  --check-upstream checks tracked refs only and reports untracked snapshots.',
    '',
    'Network access:',
    '  build, list, status, remove, add --dir, add --from, serve, and mcp configure codex use local files.',
    '  setup lists detected providers and applies selected changes only after final confirmation.',
    '  setup only requires network access for curated docs you select.',
    '  add --github fetches a public GitHub source over HTTPS and pins the resolved commit.',
    '  add/update nestjs@<major> fetch official documentation over HTTPS.',
    '  status --check-upstream resolves tracked refs over HTTPS without downloading docs.',
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
