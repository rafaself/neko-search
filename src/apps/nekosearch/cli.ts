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
import { isHelpInvocation, renderCliHelp } from './cli-help.js';
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
  arguments_.length === 2 &&
  arguments_[1]
) {
  runMcpProviderCommand('configure', arguments_[1]);
} else if (
  command === 'mcp' &&
  arguments_[0] === 'remove' &&
  arguments_.length === 2 &&
  arguments_[1]
) {
  runMcpProviderCommand('remove', arguments_[1]);
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
} else if (isHelpInvocation(command, arguments_)) {
  process.stdout.write(renderCliHelp());
} else {
  process.stderr.write(`Unknown command: ${command}\n${renderCliHelp()}`);
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
      `nekosearch status failed: ${errorMessage(error)}\n${renderCliHelp()}`,
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
      `nekosearch add --github failed: ${errorMessage(error)}\n${renderCliHelp()}`,
    );
    process.exitCode = 2;
    return;
  }
  if (!values.github || !values.ref || !values.path || !values.id) {
    process.stderr.write(
      `nekosearch add --github requires --github <repository-url> --ref <ref> --path <docs-dir> --id <source@version>\n${renderCliHelp()}`,
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

function runMcpProviderCommand(
  operation: 'configure' | 'remove',
  provider: string,
): void {
  void Promise.all([import('./setup-clients.js'), import('./mcp-command.js')])
    .then(([setupClients, mcpCommand]) => {
      const serverCommand = mcpCommand.createNekosearchStdioCommand(
        fileURLToPath(import.meta.url),
      );
      return operation === 'configure'
        ? setupClients.configureSetupClient(provider, { serverCommand })
        : setupClients.removeSetupClient(provider, { serverCommand });
    })
    .then((result) => {
      const message =
        operation === 'configure'
          ? result === 'added'
            ? `Configured ${provider} MCP server nekosearch.`
            : `${provider} MCP server nekosearch is already configured.`
          : result === 'removed'
            ? `Removed ${provider} MCP server nekosearch.`
            : `${provider} MCP server nekosearch is already absent.`;
      process.stdout.write(`${message}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `nekosearch mcp ${operation} ${provider} failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
