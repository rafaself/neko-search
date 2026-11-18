import { jest } from '@jest/globals';
import type { DocumentationCatalogEntry } from '../../../../apps/nekosearch/src/catalog.js';
import {
  runSetup,
  SETUP_BACK,
  type SetupDependencies,
  type SetupChoice,
  type SetupGroupedChoices,
  type SetupPromptApi,
  type SetupSpinner,
} from '../../../../apps/nekosearch/src/setup.js';
import type {
  SetupClientId,
  SetupClientStatus,
} from '../../../../apps/nekosearch/src/setup-clients.js';
import type { NekosearchStdioCommand } from '../../../../apps/nekosearch/src/mcp-command.js';

const CANCELED = Symbol('canceled');
const SERVER_COMMAND: NekosearchStdioCommand = {
  command: '/usr/local/node with spaces/bin/node',
  args: ['/opt/nekosearch install/dist/apps/nekosearch/cli.js', 'serve'],
};

describe('nekosearch setup flow', () => {
  it('waits for final confirmation before installing docs or configuring providers', async () => {
    const events: string[] = [];
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], ['grok-build']],
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
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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
      'configure:grok-build',
    ]);
    expect(prompts.confirmations).toEqual([
      'Proceed with these changes? (Backspace returns to provider selection)',
    ]);
    expect(prompts.messages.join('\n')).toContain(
      'Changes to be applied\nDocumentation:\n  nestjs@12\nMCP clients:\n  Grok Build CLI\n    Scope: User\n    Target: Grok Build user MCP registry (managed by `grok mcp`)\n    Action: Add NekoSearch\nOther provider settings will be preserved.',
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
      'start:Configuring Grok Build CLI',
      'stop:Configured Grok Build CLI',
    ]);
  });

  it('returns to previous steps and restores the last confirmed selections', async () => {
    const prompts = createPrompts({
      multiSelections: [
        ['nestjs@12'],
        SETUP_BACK,
        ['nestjs@11'],
        ['grok-build'],
        ['grok-build'],
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
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
      configureClient: (id) => {
        configured.push(id);
        return Promise.resolve('added');
      },
    });

    expect(result).toBe(0);
    expect(installed).toEqual(['nestjs@11']);
    expect(configured).toEqual(['grok-build']);
    expect(prompts.multiselectCalls[1]?.initialValues).toEqual(['nestjs@12']);
    expect(prompts.groupMultiselectCalls[2]?.initialValues).toEqual([
      'grok-build',
    ]);
  });

  it('shows the available provider and its user scope', async () => {
    const prompts = createPrompts({
      multiSelections: [[], ['grok-build']],
      confirmations: [true],
    });
    const configured: string[] = [];

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
      configureClient: (id) => {
        configured.push(id);
        return Promise.resolve('added');
      },
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.groups['MCP providers']).toEqual([
      {
        value: 'grok-build',
        label: 'Grok Build CLI',
        hint: 'Available · User',
        disabled: false,
      },
    ]);
    expect(configured).toEqual(['grok-build']);
  });

  it('removes a verified configured provider when unchecked', async () => {
    const prompts = createPrompts({
      multiSelections: [[], []],
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
            ...client('grok-build', 'Grok Build CLI'),
            state: 'already-configured',
            registration: 'configured',
          },
        ]),
      configureClient,
      removeClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.groups).toEqual({
      'MCP providers': [
        {
          value: 'grok-build',
          label: 'Grok Build CLI',
          hint: 'Already configured · User',
          disabled: false,
        },
      ],
    });
    expect(prompts.groupMultiselectCalls[0]?.initialValues).toEqual([
      'grok-build',
    ]);
    expect(prompts.messages.join('\n')).toContain(
      'Action: Remove NekoSearch configuration',
    );
    expect(configureClient).not.toHaveBeenCalled();
    expect(removeClient).toHaveBeenCalledWith('grok-build', expect.any(Object));
    expect(prompts.messages.at(-1)).toContain(
      'Providers removed: Grok Build CLI',
    );
  });

  it('keeps a checked configured provider without showing a confirmation', async () => {
    const prompts = createPrompts({ multiSelections: [[], ['grok-build']] });
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
            ...client('grok-build', 'Grok Build CLI'),
            state: 'already-configured',
            registration: 'configured',
          },
        ]),
      configureClient,
      removeClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.initialValues).toEqual([
      'grok-build',
    ]);
    expect(prompts.confirmations).toEqual([]);
    expect(configureClient).not.toHaveBeenCalled();
    expect(removeClient).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain(
      'Providers kept configured: Grok Build CLI',
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
            ...client('grok-build', 'Grok Build CLI'),
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

  it('shows conflicts as disabled and does not modify their registration', async () => {
    const prompts = createPrompts({ multiSelections: [[]] });
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
            ...client('grok-build', 'Grok Build CLI'),
            state: 'conflict',
            registration: 'conflict',
            reason: 'registration has a different command',
          },
        ]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls[0]?.groups).toEqual({
      'MCP providers': [
        {
          value: 'grok-build',
          label: 'Grok Build CLI',
          hint: 'Conflict · registration has a different command',
          disabled: true,
        },
      ],
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

  it('omits providers with unsupported inspection output from setup choices', async () => {
    const prompts = createPrompts({ multiSelections: [[]] });
    const unsupported: SetupClientStatus = {
      ...client('grok-build', 'Grok Build CLI'),
      state: 'unsupported',
      setupMode: 'unsupported',
      registration: 'unknown',
    };
    const configureClient =
      jest.fn<NonNullable<SetupDependencies['configureClient']>>();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([unsupported]),
      configureClient,
    });

    expect(result).toBe(0);
    expect(prompts.groupMultiselectCalls).toHaveLength(0);
    expect(prompts.messages.join('\n')).toContain(
      'Detected MCP providers do not expose a supported inspection interface: Grok Build CLI.',
    );
    expect(prompts.messages.join('\n')).not.toContain('Grok Build CLI\n');
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
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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
      Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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
      multiSelections: [['nestjs@12'], ['grok-build']],
      confirmations: [false],
    });

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      install,
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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

  it('skips model installation when Semantic Search is declined', async () => {
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], []],
      selections: ['disable'],
      confirmations: [true],
    });
    const installAndEnableSemanticSearch =
      jest.fn<
        NonNullable<SetupDependencies['installAndEnableSemanticSearch']>
      >();
    const installedDocs: string[] = [];

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([]),
      install: (source, version) => {
        installedDocs.push(`${source}@${version}`);
        return Promise.resolve({
          entry: {} as DocumentationCatalogEntry,
          changed: true,
        });
      },
      installAndEnableSemanticSearch,
    });

    expect(result).toBe(0);
    expect(installedDocs).toEqual(['nestjs@12']);
    expect(installAndEnableSemanticSearch).not.toHaveBeenCalled();
    expect(prompts.selectCalls[0]?.options).toEqual([
      {
        value: 'enable',
        label: 'Install now',
        hint: 'Qwen3 model (~625 MB) and inference runtime',
      },
      {
        value: 'disable',
        label: 'Skip for now',
        hint: 'Lexical Search stays available',
      },
    ]);
    expect(prompts.messages.at(-1)).toContain('Semantic Search: disabled');
  });

  it('installs and enables the model before ingesting selected documentation', async () => {
    const prompts = createPrompts({
      multiSelections: [['nestjs@12'], []],
      selections: ['enable'],
      confirmations: [true],
    });
    const events: string[] = [];

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([]),
      installAndEnableSemanticSearch: (progress) => {
        events.push('semantic');
        progress('Qwen3 download progress');
        return Promise.resolve();
      },
      install: (source, version) => {
        events.push(`docs:${source}@${version}`);
        return Promise.resolve({
          entry: {} as DocumentationCatalogEntry,
          changed: true,
        });
      },
    });

    expect(result).toBe(0);
    expect(events).toEqual(['semantic', 'docs:nestjs@12']);
    expect(prompts.spinnerCalls[0]).toEqual([
      'start:Installing the runtime and Qwen3 for Semantic Search',
      'message:Qwen3 download progress',
      'stop:Qwen3 and runtime ready. Semantic Search enabled',
    ]);
    expect(prompts.messages.at(-1)).toContain('Semantic Search: enabled');
  });

  it('disables Semantic Search on explicit setup choice without removing vectors or model', async () => {
    const prompts = createPrompts({
      selections: ['disable'],
      confirmations: [true],
    });
    const disableSemanticSearch = jest.fn<
      NonNullable<SetupDependencies['disableSemanticSearch']>
    >(() => Promise.resolve());
    const installAndEnableSemanticSearch =
      jest.fn<
        NonNullable<SetupDependencies['installAndEnableSemanticSearch']>
      >();

    const result = await runSetup({
      terminal: { stdinIsTTY: true, stdoutIsTTY: true },
      prompts,
      serverCommand: SERVER_COMMAND,
      listIndexes: () => Promise.resolve([]),
      inspectClients: () => Promise.resolve([]),
      readSemanticSearchEnabled: () => Promise.resolve(true),
      disableSemanticSearch,
      installAndEnableSemanticSearch,
    });

    expect(result).toBe(0);
    expect(disableSemanticSearch).toHaveBeenCalledTimes(1);
    expect(installAndEnableSemanticSearch).not.toHaveBeenCalled();
    expect(prompts.messages.at(-1)).toContain('Semantic Search: disabled');
    expect(prompts.spinnerCalls[0]).toEqual([
      'start:Disabling Semantic Search',
      'stop:Disabled Semantic Search; model and existing embeddings were preserved',
    ]);
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
      inspectClients: () =>
        Promise.resolve([client('grok-build', 'Grok Build CLI')]),
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
    configuration: 'managed',
    registration: 'missing',
    setupMode: 'automatic',
    scope: 'user',
    target: 'Grok Build user MCP registry (managed by `grok mcp`)',
  };
}

interface PromptAnswers {
  multiSelections?: (string[] | symbol)[];
  selections?: (string | symbol)[];
  confirmations?: (boolean | symbol)[];
  onConfirm?: () => void;
}

function createPrompts(answers: PromptAnswers = {}): SetupPromptApi & {
  messages: string[];
  confirmations: string[];
  selectCalls: Array<{
    message: string;
    options: SetupChoice<string>[];
    initialValue?: string;
  }>;
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
  const selectionResults = [...(answers.selections ?? [])];
  const confirmationResults = [...(answers.confirmations ?? [])];
  const messages: string[] = [];
  const confirmations: string[] = [];
  const selectCalls: Array<{
    message: string;
    options: SetupChoice<string>[];
    initialValue?: string;
  }> = [];
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
    selectCalls,
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
    select: <T extends string>(
      message: string,
      options: SetupChoice<T>[],
      initialValue?: T,
    ) => {
      selectCalls.push({
        message,
        options,
        ...(initialValue !== undefined && { initialValue }),
      });
      return Promise.resolve(
        (selectionResults.shift() ?? initialValue ?? options[0]?.value) as
          T | symbol,
      );
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
