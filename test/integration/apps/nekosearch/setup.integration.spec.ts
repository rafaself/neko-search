import { jest } from '@jest/globals';
import type { DocumentationCatalogEntry } from '../../../../src/apps/nekosearch/catalog.js';
import {
  runSetup,
  SETUP_BACK,
  type SetupDependencies,
  type SetupChoice,
  type SetupPromptApi,
  type SetupSpinner,
} from '../../../../src/apps/nekosearch/setup.js';
import type { SetupClientId } from '../../../../src/apps/nekosearch/setup-clients.js';
import type { NekosearchStdioCommand } from '../../../../src/apps/nekosearch/mcp-command.js';

const CANCELED = Symbol('canceled');
const SERVER_COMMAND: NekosearchStdioCommand = {
  command: '/usr/local/node with spaces/bin/node',
  args: ['/opt/nekosearch install/dist/apps/nekosearch/cli.js', 'serve'],
};

describe('nekosearch setup flow', () => {
  it('waits for final confirmation before installing docs or configuring providers', async () => {
    const events: string[] = [];
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], ['codex']],
      confirmations: [true],
      onConfirm: () => events.push('confirmed'),
    });
    const install: NonNullable<SetupDependencies['install']> = (
      source,
      version,
      _operation,
      options,
    ) => {
      events.push(`install:${source}@${version}`);
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
      events.push(`configure:${id}`);
      return Promise.resolve('added');
    };

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, term: 'dumb' },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(events).toEqual([
      'confirmed',
      'install:nestjs@12',
      'configure:codex',
    ]);
    expect(prompts.confirmations).toEqual([
      'Confirm and apply these changes? (Backspace returns to provider selection)',
    ]);
    expect(prompts.messages).toContain('Documentation to install: nestjs@12');
    expect(prompts.messages).toContain('Providers to configure: Codex');
    expect(prompts.messages.at(-1)).toContain(
      'Documentation installed: nestjs@12',
    );
    expect(prompts.spinnerCalls).toHaveLength(2);
    expect(prompts.spinnerCalls[0]).toEqual(
      expect.arrayContaining([
        'start:nestjs@12: preparing snapshot',
        'message:nestjs@12: resolving the upstream ref',
        'message:nestjs@12: downloading documentation',
        'message:nestjs@12: building the local index',
        'message:nestjs@12: validating the snapshot',
        'message:nestjs@12: installing the snapshot',
        'stop:Installed nestjs@12',
      ]),
    );
    expect(prompts.spinnerCalls[1]).toEqual([
      'start:Configuring Codex',
      'stop:Configured Codex',
    ]);
  });

  it('returns to previous steps and restores the last confirmed selections', async () => {
    const prompts = createPrompts({
      multiSelections: [
        ['nestjs@12'],
        SETUP_BACK,
        ['nestjs@11'],
        ['codex'],
        ['codex'],
      ],
      confirmations: [SETUP_BACK, true],
    });
    const installed: string[] = [];
    const configured: string[] = [];

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install: (source, version) => {
        installed.push(`${source}@${version}`);
        return Promise.resolve({
          entry: {} as DocumentationCatalogEntry,
          changed: true,
        });
      },
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient: (id) => {
        configured.push(id);
        return Promise.resolve('added');
      },
    });

    expect(result).toBe(0);
    expect(installed).toEqual(['nestjs@11']);
    expect(configured).toEqual(['codex']);
    expect(prompts.multiselectCalls[2]?.initialValues).toEqual(['nestjs@12']);
    expect(prompts.multiselectCalls[4]?.initialValues).toEqual(['codex']);
  });

  it('shows the detected provider choices without state labels', async () => {
    const prompts = createPrompts({
      multiSelections: [[], ['codex', 'cursor', 'github-copilot', 'cline']],
      confirmations: [true],
    });
    const configured: string[] = [];

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient: (id) => {
        configured.push(id);
        return Promise.resolve('added');
      },
    });

    expect(result).toBe(0);
    expect(prompts.multiselectCalls[1]?.options).toEqual([
      { value: 'codex', label: 'Codex' },
    ]);
    expect(configured).toEqual(['codex']);
    expect(prompts.messages.join('\n')).not.toMatch(
      /:\s*(available|not detected|already configured|conflict)\b/u,
    );
  });

  it('shows Codex when its legacy registration needs reviewed replacement', async () => {
    const prompts = createPrompts({
      multiSelections: [[], ['codex']],
      confirmations: [true],
    });
    let replacementApprovedForCodex = false;

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            id: 'codex',
            label: 'Codex',
            requiresReplacement: true,
          },
        ]),
      configureClient: (_id, options) => {
        replacementApprovedForCodex = options.replaceConflictingCodex === true;
        return Promise.resolve('added');
      },
    });

    expect(result).toBe(0);
    expect(prompts.multiselectCalls[1]?.options).toEqual([
      {
        value: 'codex',
        label: 'Codex',
        hint: 'replace existing NekoSearch registration',
      },
    ]);
    expect(prompts.messages).toContain(
      'Providers to configure: Codex (replace existing NekoSearch registration)',
    );
    expect(replacementApprovedForCodex).toBe(true);
  });

  it('does not name unavailable providers when none are detected', async () => {
    const prompts = createPrompts({
      multiSelections: [[]],
      confirmations: [true, true],
    });
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(prompts.messages.join('\n')).toContain(
      'No supported MCP providers were detected.',
    );
    expect(prompts.messages.join('\n')).not.toMatch(/Cursor|Cline/u);
    expect(configureClient).not.toHaveBeenCalled();
  });

  it('lets users finish with no changes and performs no network or client writes', async () => {
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const prompts = createPrompts({
      multiSelections: [[], []],
      confirmations: [true],
    });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
    expect(prompts.messages).toContain('Documentation to install: none');
    expect(prompts.messages).toContain('Providers to configure: none');
  });

  it('exits before catalog reads, downloads, client checks, or writes in non-TTY mode', async () => {
    const output: string[] = [];
    const listIndexes = jest.fn(() => Promise.resolve([]));
    const inspectClients = jest.fn(() => Promise.resolve([]));
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

  it('cancellation before review performs no install or client configuration', async () => {
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
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient,
    });

    expect(result).toBe(130);
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
  });

  it('cancelling the final review leaves all selected operations unapplied', async () => {
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], ['codex']],
      confirmations: [false],
    });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
      configureClient,
    });

    expect(result).toBe(130);
    expect(install).not.toHaveBeenCalled();
    expect(configureClient).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain('No changes were made.');
  });

  it('continues after a docs failure and reports one final line per source', async () => {
    const prompts = createPrompts({
      multiSelections: [['nestjs@11', 'nestjs@12'], []],
      confirmations: [true, true],
    });
    const attempted: string[] = [];
    const install: NonNullable<SetupDependencies['install']> = (
      source,
      version,
    ) => {
      const selector = `${source}@${version}`;
      attempted.push(selector);
      if (version === '11') return Promise.reject(new Error('mocked timeout'));
      return Promise.resolve({
        entry: {} as DocumentationCatalogEntry,
        changed: true,
      });
    };

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
    });

    expect(result).toBe(1);
    expect(attempted).toEqual(['nestjs@11', 'nestjs@12']);
    expect(prompts.spinnerCalls).toHaveLength(2);
    expect(
      prompts.spinnerCalls[0]?.filter((line) => line.startsWith('error:')),
    ).toHaveLength(1);
    expect(
      prompts.spinnerCalls[1]?.filter((line) => line.startsWith('stop:')),
    ).toHaveLength(1);
    expect(prompts.messages.at(-1)).toContain(
      'Documentation installed: nestjs@12',
    );
    expect(prompts.messages.at(-1)).toContain('mocked timeout');
  });

  it('shows installed selectors without an added status label', async () => {
    const prompts = createPrompts({
      multiSelections: [[], []],
      confirmations: [true],
    });
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
      inspectClients: () => Promise.resolve([client('codex', 'Codex')]),
    });

    expect(prompts.multiselectCalls[0]?.options).toEqual(
      expect.arrayContaining([
        {
          value: 'nestjs@12',
          label: 'nestjs@12',
          disabled: true,
        },
      ]),
    );
  });
});

function client(
  id: SetupClientId,
  label: string,
): { id: SetupClientId; label: string } {
  return { id, label };
}

interface PromptAnswers {
  multiSelections?: (string[] | symbol)[];
  confirmations?: (boolean | symbol)[];
  onConfirm?: () => void;
}

function createPrompts(answers: PromptAnswers = {}): SetupPromptApi & {
  messages: string[];
  confirmations: string[];
  multiselectCalls: Array<{
    message: string;
    options: SetupChoice<string>[];
    initialValues: string[];
  }>;
  spinnerCalls: string[][];
} {
  const multiSelections = [...(answers.multiSelections ?? [])];
  const confirmationResults = [...(answers.confirmations ?? [])];
  const messages: string[] = [];
  const confirmations: string[] = [];
  const multiselectCalls: Array<{
    message: string;
    options: SetupChoice<string>[];
    initialValues: string[];
  }> = [];
  const spinnerCalls: string[][] = [];

  return {
    messages,
    confirmations,
    multiselectCalls,
    spinnerCalls,
    intro: (message) => messages.push(message),
    message: (message) => messages.push(message),
    error: (message) => messages.push(message),
    outro: (message) => messages.push(message),
    isCancel: (value): value is symbol => value === CANCELED,
    isBack: (value) => value === SETUP_BACK,
    multiselect: <T extends string>(
      message: string,
      options: SetupChoice<T>[],
      initialValues: readonly T[] = [],
    ) => {
      multiselectCalls.push({
        message,
        options,
        initialValues: [...initialValues],
      });
      return Promise.resolve((multiSelections.shift() ?? []) as T[] | symbol);
    },
    confirm: (message) => {
      confirmations.push(message);
      answers.onConfirm?.();
      return Promise.resolve(confirmationResults.shift() ?? true);
    },
    spinner: (): SetupSpinner => {
      const events: string[] = [];
      spinnerCalls.push(events);
      return {
        start: (message) => events.push(`start:${message}`),
        message: (message) => events.push(`message:${message}`),
        stop: (message) => events.push(`stop:${message}`),
        error: (message) => events.push(`error:${message}`),
      };
    },
    cancel: (message) => messages.push(message),
  };
}
