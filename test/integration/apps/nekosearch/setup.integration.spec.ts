import { jest } from '@jest/globals';
import type { DocumentationCatalogEntry } from '../../../../src/apps/nekosearch/catalog.js';
import {
  runSetup,
  SETUP_BACK,
  type SetupDependencies,
  type SetupChoice,
  type SetupGroupedChoices,
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
    expect(prompts.messages[0]).toBe(`          /\\        /\\
         /  \\______/  \\
        (    ^ v ^     )
         \\____________/
   _     /            \\
  / )   /              \\
  \\ \\___\\   (__) (__)  /
   \\_____\\____________/

         NekoSearch`);
    expect(events).toEqual([
      'confirmed',
      'install:nestjs@12',
      'configure:codex',
    ]);
    expect(prompts.confirmations).toEqual([
      'Proceed with these changes? (Backspace returns to provider selection)',
    ]);
    expect(prompts.messages.join('\n')).toContain(
      'Changes to be applied\nDocumentation:\n  nestjs@12\nMCP clients:\n  Codex\n    Scope: User\n    Target: /codex/mcp.json\n    Action: Add NekoSearch\nOther provider settings will be preserved.',
    );
    expect(prompts.messages.at(-1)).toContain(
      'Documentation installed: nestjs@12',
    );
    expect(prompts.spinnerCalls).toHaveLength(2);
    expect(prompts.spinnerPlainCalls).toEqual([true, true]);
    expect(prompts.spinnerCalls[0]).toEqual(
      expect.arrayContaining([
        'start:nestjs@12: installing snapshot',
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
    expect(prompts.multiselectCalls[1]?.initialValues).toEqual(['nestjs@12']);
    expect(prompts.groupMultiselectCalls[2]?.initialValues).toEqual(['codex']);
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
    expect(prompts.groupMultiselectCalls[0]?.groups['MCP providers']).toEqual([
      { value: 'codex', label: 'Codex', hint: 'User' },
    ]);
    expect(configured).toEqual(['codex']);
    expect(prompts.messages.join('\n')).not.toMatch(
      /:\s*(available|not detected|already configured|conflict)\b/u,
    );
  });

  it('starts a replaceable Codex registration checked and removes it when unchecked', async () => {
    const prompts = createPrompts({
      multiSelections: [[], ['cursor']],
      confirmations: [true],
    });
    const configureClient = jest
      .fn<NonNullable<SetupDependencies['configureClient']>>()
      .mockResolvedValue('added');
    const removeClient = jest
      .fn<NonNullable<SetupDependencies['removeClient']>>()
      .mockResolvedValue('removed');
    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            ...client('codex', 'Codex'),
            state: 'already-configured',
            application: 'not-detected',
            registration: 'configured',
            replaceable: true,
          },
          client('cursor', 'Cursor'),
        ]),
      configureClient,
      removeClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.groups).toEqual({
      'MCP providers': [
        {
          value: 'codex',
          label: 'Codex',
          hint: 'Already configured',
        },
        { value: 'cursor', label: 'Cursor', hint: 'User' },
      ],
    });
    expect(prompts.groupMultiselectCalls[0]?.initialValues).toEqual(['codex']);
    expect(prompts.messages.join('\n')).toContain(
      'Action: Remove NekoSearch configuration',
    );
    expect(configureClient).toHaveBeenCalledWith('cursor', expect.any(Object));
    expect(removeClient).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ removeConflictingCodex: true }),
    );
    expect(prompts.messages.at(-1)).toContain('Providers removed: Codex');
  });

  it('updates a checked replaceable Codex registration to the current CLI', async () => {
    const prompts = createPrompts({
      multiSelections: [[], ['codex']],
      confirmations: [true],
    });
    const configureClient = jest
      .fn<NonNullable<SetupDependencies['configureClient']>>()
      .mockResolvedValue('added');
    const removeClient =
      jest.fn<NonNullable<SetupDependencies['removeClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            ...client('codex', 'Codex'),
            state: 'already-configured',
            registration: 'configured',
            replaceable: true,
          },
        ]),
      configureClient,
      removeClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.initialValues).toEqual(['codex']);
    expect(prompts.messages.join('\n')).toContain(
      'Action: Update NekoSearch registration',
    );
    expect(configureClient).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ replaceConflictingCodex: true }),
    );
    expect(removeClient).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain('Providers configured: Codex');
  });

  it('keeps a checked configured provider without showing a confirmation', async () => {
    const prompts = createPrompts({ multiSelections: [[], ['codex']] });
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const removeClient =
      jest.fn<NonNullable<SetupDependencies['removeClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            ...client('codex', 'Codex'),
            state: 'already-configured',
            registration: 'configured',
          },
        ]),
      configureClient,
      removeClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.initialValues).toEqual(['codex']);
    expect(prompts.confirmations).toEqual([]);
    expect(configureClient).not.toHaveBeenCalled();
    expect(removeClient).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain(
      'Providers kept configured: Codex',
    );
  });

  it('does not remove a configured provider when removal is declined', async () => {
    const prompts = createPrompts({
      multiSelections: [[], []],
      confirmations: [false],
    });
    const removeClient =
      jest.fn<NonNullable<SetupDependencies['removeClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            ...client('codex', 'Codex'),
            state: 'already-configured',
            registration: 'configured',
          },
        ]),
      removeClient,
    });

    expect(result).toBe(130);
    expect(prompts.confirmations).toHaveLength(1);
    expect(removeClient).not.toHaveBeenCalled();
  });

  it('omits conflicting providers from the selectable choices', async () => {
    const prompts = createPrompts({ multiSelections: [[], ['codex']] });
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([
          {
            ...client('codex', 'Codex'),
            state: 'conflict',
            registration: 'conflict',
            reason: 'legacy Codex registration exists',
          },
          client('cursor', 'Cursor'),
        ]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.groups).toEqual({
      'MCP providers': [{ value: 'cursor', label: 'Cursor', hint: 'User' }],
    });
    expect(configureClient).not.toHaveBeenCalled();
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

  it('omits manual-only and undetected providers from setup choices', async () => {
    const prompts = createPrompts({ multiSelections: [[]] });
    const junie: SetupClientStatus = {
      id: 'junie',
      label: 'Junie',
      state: 'manual-only',
      application: 'manual-only',
      configuration: 'unknown',
      registration: 'unknown',
      setupMode: 'manual',
      scope: 'user',
      target: '/home/user/.junie/mcp/mcp.json',
    };
    const undetected: SetupClientStatus = {
      ...client('cursor', 'Cursor'),
      state: 'not-detected',
      application: 'not-detected',
    };
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([junie, undetected]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls).toHaveLength(0);
    expect(prompts.messages.join('\n')).not.toContain('Junie');
    expect(prompts.messages.join('\n')).not.toContain(
      'Other supported clients',
    );
    expect(prompts.messages.join('\n')).not.toContain(
      'Show manual setup instructions',
    );
    expect(configureClient).not.toHaveBeenCalled();
  });

  it('skips the docs prompt when all curated snapshots are installed', async () => {
    const prompts = createPrompts();
    const installedEntries = ['11', '12'].map(
      (version) =>
        ({
          source: 'nestjs',
          version,
          revision: `fixture-${version}`,
          status: 'installed',
        }) as DocumentationCatalogEntry,
    );
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve(installedEntries),
      inspectClients: () => Promise.resolve([]),
      install,
    });

    expect(result).toBe(0);
    expect(prompts.messages).toContain(
      'All curated documentation snapshots are already installed.',
    );
    expect(prompts.multiselectCalls).toHaveLength(0);
    expect(install).not.toHaveBeenCalled();
  });

  it('skips docs selection when the recipe list is empty', async () => {
    const prompts = createPrompts();
    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      recipes: [],
      inspectClients: () => Promise.resolve([]),
    });

    expect(result).toBe(0);
    expect(prompts.messages).toContain(
      'No curated documentation snapshots are available.',
    );
    expect(prompts.multiselectCalls).toHaveLength(0);
  });

  it('reports an unreadable catalog without showing disabled choices', async () => {
    const prompts = createPrompts();
    const install = jest.fn<NonNullable<SetupDependencies['install']>>();
    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.reject(new Error('catalog permissions')),
      inspectClients: () => Promise.resolve([]),
      install,
    });

    expect(result).toBe(1);
    expect(prompts.messages.join('\n')).toContain(
      'Could not read the documentation catalog: catalog permissions',
    );
    expect(prompts.multiselectCalls).toHaveLength(0);
    expect(install).not.toHaveBeenCalled();
  });

  it('skips provider selection and configuration when client inspection fails', async () => {
    const prompts = createPrompts();
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();
    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.reject(new Error('provider read failed')),
      configureClient,
    });

    expect(result).toBe(1);
    expect(prompts.messages.join('\n')).toContain(
      'Could not inspect MCP providers: provider read failed',
    );
    expect(prompts.groupMultiselectCalls).toHaveLength(0);
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
    expect(prompts.messages.join('\n')).toContain(
      'Setup finished with no changes.',
    );
    expect(prompts.confirmations).toHaveLength(0);
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
    const inspectClients = jest.fn(() =>
      Promise.resolve([client('codex', 'Codex')]),
    );
    const prompts = createPrompts({ multiSelections: [CANCELED] });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients,
      configureClient,
    });

    expect(result).toBe(130);
    expect(inspectClients).not.toHaveBeenCalled();
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

  it('marks installed selectors with a check without added status text', async () => {
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
          hint: '✓',
          disabled: true,
        },
      ]),
    );
  });
});

function client(id: SetupClientId, label: string): SetupClientStatus {
  return {
    id,
    label,
    state: 'ready',
    application: 'detected',
    configuration: 'missing',
    registration: 'missing',
    setupMode: 'automatic',
    scope: 'user',
    target: `/${id}/mcp.json`,
  };
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
  groupMultiselectCalls: Array<{
    message: string;
    groups: SetupGroupedChoices<string>;
    initialValues: string[];
  }>;
  spinnerCalls: string[][];
  spinnerPlainCalls: boolean[];
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
  const groupMultiselectCalls: Array<{
    message: string;
    groups: SetupGroupedChoices<string>;
    initialValues: string[];
  }> = [];
  const spinnerCalls: string[][] = [];
  const spinnerPlainCalls: boolean[] = [];

  return {
    messages,
    confirmations,
    multiselectCalls,
    groupMultiselectCalls,
    spinnerCalls,
    spinnerPlainCalls,
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
    groupMultiselect: <T extends string>(
      message: string,
      groups: SetupGroupedChoices<T>,
      initialValues: readonly T[] = [],
    ) => {
      groupMultiselectCalls.push({
        message,
        groups,
        initialValues: [...initialValues],
      });
      return Promise.resolve((multiSelections.shift() ?? []) as T[] | symbol);
    },
    confirm: (message) => {
      confirmations.push(message);
      answers.onConfirm?.();
      return Promise.resolve(confirmationResults.shift() ?? true);
    },
    spinner: (plain): SetupSpinner => {
      spinnerPlainCalls.push(plain);
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
