import { jest } from '@jest/globals';
import type { DocumentationCatalogEntry } from '../../../../src/apps/nekosearch/catalog.js';
import type { RemoteSnapshotPhase } from '../../../../src/apps/nekosearch/remote-snapshots.js';
import {
  runSetup,
  type SetupDependencies,
  type SetupChoice,
  type SetupPromptApi,
  type SetupSpinner,
} from '../../../../src/apps/nekosearch/setup.js';
import type {
  SetupClientId,
  SetupClientStatus,
} from '../../../../src/apps/nekosearch/setup-clients.js';
import type { NekosearchStdioCommand } from '../../../../src/apps/nekosearch/mcp-command.js';

const CANCELED = Symbol('canceled');
const SERVER_COMMAND: NekosearchStdioCommand = {
  command: '/usr/local/node with spaces/bin/node',
  args: ['/opt/nekosearch install/dist/apps/nekosearch/cli.js', 'serve'],
};

describe('nekosearch setup flow', () => {
  it('installs selected docs, shows actual phases, confirms client writes, and summarizes results', async () => {
    const calls: string[] = [];
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], ['codex']],
      action: 'choose',
      confirmation: true,
    });
    const install: NonNullable<SetupDependencies['install']> = (
      source,
      version,
      operation,
      options,
    ) => {
      calls.push(`${operation}:${source}@${version}`);
      for (const phase of [
        'resolving',
        'downloading',
        'indexing',
        'validating',
        'installing',
      ] as const) {
        options?.onProgress?.(phase);
      }
      return Promise.resolve({
        entry: {} as DocumentationCatalogEntry,
        changed: true,
      });
    };
    const configureClient: NonNullable<SetupDependencies['configureClient']> = (
      id,
    ) => {
      calls.push(`configure:${id}`);
      return Promise.resolve('added');
    };
    const phases: RemoteSnapshotPhase[] = [];
    const wrappedInstall: NonNullable<SetupDependencies['install']> = (
      source,
      version,
      operation,
      options,
    ) => {
      return install(source, version, operation, {
        ...options,
        onProgress: (phase) => {
          phases.push(phase);
          options?.onProgress?.(phase);
        },
      });
    };

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, term: 'dumb' },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install: wrappedInstall,
      inspectClients: () => Promise.resolve(clientStatuses()),
      configureClient,
    });

    expect(result).toBe(0);
    expect(calls).toEqual(['add:nestjs@12', 'configure:codex']);
    expect(phases).toEqual([
      'resolving',
      'downloading',
      'indexing',
      'validating',
      'installing',
    ]);
    expect(prompts.confirmations).toEqual(['Configure NekoSearch in: Codex?']);
    expect(prompts.messages.at(-1)).toContain(
      'Documentation installed: nestjs@12',
    );
    expect(prompts.messages.at(-1)).toContain('MCP clients configured: codex');
    expect(prompts.plainSpinner).toBe(true);
  });

  it('lets users skip both steps without network or client writes', async () => {
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const prompts = createPrompts({ multiSelections: [[]], action: 'skip' });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve(clientStatuses()),
      configureClient,
    });

    expect(result).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain(
      'Skipped: documentation, client setup',
    );
  });

  it('exits before catalog reads, downloads, or writes in non-TTY mode', async () => {
    const output: string[] = [];
    const listIndexes = jest.fn(() => Promise.resolve([]));
    const inspectClients = jest.fn(() => Promise.resolve(clientStatuses()));
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
      writeOutput: (message) => output.push(message),
      listIndexes,
      inspectClients,
      install,
      configureClient,
    });

    expect(result).toBe(2);
    expect(output.join('')).toContain('made no changes');
    expect(listIndexes).not.toHaveBeenCalled();
    expect(inspectClients).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
  });

  it('cancellation before docs selection performs no install or client configuration', async () => {
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const prompts = createPrompts({ multiSelections: [CANCELED] });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve(clientStatuses()),
      configureClient,
    });

    expect(result).toBe(130);
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
  });

  it('continues to client setup after one selected documentation install fails', async () => {
    const attempts: string[] = [];
    const install: NonNullable<SetupDependencies['install']> = (
      source,
      version,
    ) => {
      const selector = `${source}@${version}`;
      attempts.push(selector);
      if (version === '11') {
        return Promise.reject(new Error('mocked upstream timeout'));
      }
      return Promise.resolve({
        entry: {} as DocumentationCatalogEntry,
        changed: true,
      });
    };
    const prompts = createPrompts({
      multiSelections: [['nestjs@11', 'nestjs@12']],
      action: 'skip',
    });
    let clientsInspected = false;

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => {
        clientsInspected = true;
        return Promise.resolve(clientStatuses());
      },
    });

    expect(result).toBe(1);
    expect(attempts).toEqual(['nestjs@11', 'nestjs@12']);
    expect(clientsInspected).toBe(true);
    expect(prompts.messages.at(-1)).toContain(
      'Documentation installed: nestjs@12',
    );
    expect(prompts.messages.at(-1)).toContain('mocked upstream timeout');
  });

  it('requires confirmation before changing client settings and leaves conflicts disabled', async () => {
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const prompts = createPrompts({
      multiSelections: [[], ['cursor', 'conflicting']],
      action: 'choose',
      confirmation: CANCELED,
    });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          setupClient('cursor', 'Cursor', 'available'),
          setupClient('codex', 'Codex', 'conflict'),
        ]),
      configureClient,
    });

    expect(result).toBe(130);
    expect(configureClient).not.toHaveBeenCalled();
    expect(
      prompts.clientOptions.find((choice) => choice.value === 'codex'),
    ).toMatchObject({
      disabled: true,
      hint: undefined,
    });
  });

  it('marks installed snapshots and leaves them out of the installation selection', async () => {
    const prompts = createPrompts({ multiSelections: [[]], action: 'skip' });
    const entry = {
      source: 'nestjs',
      version: '12',
      revision: 'fixture-revision',
      status: 'installed',
    } as DocumentationCatalogEntry;

    await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([entry]),
      inspectClients: () => Promise.resolve(clientStatuses()),
    });

    expect(prompts.docOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'nestjs@12',
          label: 'nestjs@12 — already installed',
          disabled: true,
        }),
      ]),
    );
  });
});

function clientStatuses(): SetupClientStatus[] {
  return [
    setupClient('codex', 'Codex', 'available'),
    setupClient('cursor', 'Cursor', 'conflict'),
    setupClient(
      'github-copilot',
      'GitHub Copilot CLI + VS Code Copilot Global',
      'already configured',
    ),
    setupClient(
      'claude-desktop',
      'Claude Desktop (manual only)',
      'not detected',
      false,
    ),
  ];
}

function setupClient(
  id: SetupClientId,
  label: string,
  state: SetupClientStatus['state'],
  automatic = true,
): SetupClientStatus {
  return { id, label, state, automatic };
}

interface PromptAnswers {
  multiSelections?: (string[] | symbol)[];
  action?: string | symbol;
  confirmation?: boolean | symbol;
}

function createPrompts(answers: PromptAnswers = {}): SetupPromptApi & {
  messages: string[];
  confirmations: string[];
  docOptions: Array<{
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>;
  clientOptions: Array<{
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>;
  plainSpinner: boolean;
} {
  const multiSelections = [...(answers.multiSelections ?? [[]])];
  const messages: string[] = [];
  const confirmations: string[] = [];
  let multiPromptCount = 0;
  let latestMultiOptions: Array<{
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }> = [];
  let docOptions: Array<{
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }> = [];
  let plainSpinner = false;
  const spinner: SetupSpinner = {
    start: () => undefined,
    stop: () => undefined,
  };
  return {
    messages,
    confirmations,
    get docOptions() {
      return docOptions;
    },
    get clientOptions() {
      return latestMultiOptions;
    },
    get plainSpinner() {
      return plainSpinner;
    },
    intro: (message) => messages.push(message),
    message: (message) => messages.push(message),
    success: (message) => messages.push(message),
    warning: (message) => messages.push(message),
    error: (message) => messages.push(message),
    outro: (message) => messages.push(message),
    isCancel: (value): value is symbol => typeof value === 'symbol',
    select: <T extends string>() =>
      Promise.resolve((answers.action ?? 'skip') as T | symbol),
    multiselect: <T extends string>(
      _message: string,
      options: SetupChoice<T>[],
    ) => {
      latestMultiOptions = options;
      if (multiPromptCount === 0) docOptions = options;
      multiPromptCount += 1;
      return Promise.resolve((multiSelections.shift() ?? []) as T[] | symbol);
    },
    confirm: (message) => {
      confirmations.push(message);
      return Promise.resolve(answers.confirmation ?? true);
    },
    spinner: (plain) => {
      plainSpinner ||= plain;
      return spinner;
    },
    cancel: (message) => messages.push(message),
  };
}
