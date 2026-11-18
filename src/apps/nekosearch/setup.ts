import * as clack from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import {
  listCatalogIndexes,
  type DocumentationCatalogEntry,
} from './catalog.js';
import {
  createNekosearchStdioCommand,
  type NekosearchStdioCommand,
} from './mcp-command.js';
import {
  CURATED_REMOTE_SNAPSHOT_RECIPES,
  installRemoteSnapshot,
  type RemoteSnapshotPhase,
} from './remote-snapshots.js';
import {
  configureSetupClient,
  inspectSetupClients,
  removeSetupClient,
  type SetupClientId,
  type SetupClientOptions,
  type SetupClientStatus,
} from './setup-clients.js';

export interface SetupChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export type SetupGroupedChoices<T extends string> = Record<
  string,
  SetupChoice<T>[]
>;

export interface SetupSpinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export const SETUP_BACK = Symbol('setup-back');

const SETUP_BANNER = String.raw`          /\        /\
         /  \______/  \
        (    ^ v ^     )
         \____________/
   _     /            \
  / )   /              \
  \ \___\   (__) (__)  /
   \_____\____________/

         NekoSearch`;

export interface SetupPromptApi {
  intro(message: string): void;
  message(message: string): void;
  error(message: string): void;
  outro(message: string): void;
  isCancel(value: unknown): value is symbol;
  isBack(value: unknown): boolean;
  multiselect<T extends string>(
    message: string,
    options: SetupChoice<T>[],
    initialValues?: readonly T[],
  ): Promise<T[] | symbol>;
  groupMultiselect<T extends string>(
    message: string,
    groups: SetupGroupedChoices<T>,
    initialValues?: readonly T[],
  ): Promise<T[] | symbol>;
  select<T extends string>(
    message: string,
    options: SetupChoice<T>[],
    initialValue?: T,
  ): Promise<T | symbol>;
  confirm(message: string): Promise<boolean | symbol>;
  spinner(plain: boolean): SetupSpinner;
  cancel(message: string): void;
}

export interface SetupTerminalState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  term?: string;
  ci?: boolean;
  accessible?: boolean;
}

export interface SetupDependencies {
  serverCommand?: NekosearchStdioCommand;
  terminal?: SetupTerminalState;
  prompts?: SetupPromptApi;
  writeOutput?: (message: string, stream: 'stdout' | 'stderr') => void;
  listIndexes?: () => Promise<DocumentationCatalogEntry[]>;
  recipes?: typeof CURATED_REMOTE_SNAPSHOT_RECIPES;
  install?: typeof installRemoteSnapshot;
  inspectClients?: typeof inspectSetupClients;
  configureClient?: typeof configureSetupClient;
  removeClient?: typeof removeSetupClient;
  readSemanticSearchEnabled?: () => Promise<boolean>;
  installAndEnableSemanticSearch?: (
    progress: (message: string) => void,
  ) => Promise<void>;
  disableSemanticSearch?: () => Promise<void>;
  clientOptions?: Omit<SetupClientOptions, 'serverCommand'>;
}

/** Interactive first-run setup. The CLI imports this module only for `setup`. */
export async function runSetup(
  dependencies: SetupDependencies = {},
): Promise<number> {
  const terminal = {
    stdinIsTTY:
      dependencies.terminal?.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY:
      dependencies.terminal?.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    term: dependencies.terminal?.term ?? process.env.TERM,
    ci: dependencies.terminal?.ci ?? isEnvironmentFlag(process.env.CI),
    accessible:
      dependencies.terminal?.accessible ??
      accessibleEnvironmentPreference(process.env.ACCESSIBLE),
  };
  const output = dependencies.writeOutput ?? defaultWriteOutput;
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    output(
      [
        'nekosearch setup needs an interactive terminal and made no changes.',
        'Re-run `nekosearch setup` in a terminal, or install docs with `nekosearch add --dir` / `nekosearch add nestjs@12` and configure an available provider.',
      ].join('\n') + '\n',
      'stderr',
    );
    return 2;
  }

  const prompts =
    dependencies.prompts ??
    createSetupPromptApi(
      process.stdin,
      process.stdout,
      process.stderr,
      terminal.accessible,
    );
  const serverCommand =
    dependencies.serverCommand ??
    createNekosearchStdioCommand(
      process.argv[1] ?? fileURLToPath(new URL('./cli.js', import.meta.url)),
    );
  const recipes = dependencies.recipes ?? CURATED_REMOTE_SNAPSHOT_RECIPES;
  const listIndexes = dependencies.listIndexes ?? listCatalogIndexes;
  const install = dependencies.install ?? installRemoteSnapshot;
  const inspectClients = dependencies.inspectClients ?? inspectSetupClients;
  const configureClient = dependencies.configureClient ?? configureSetupClient;
  const removeClient = dependencies.removeClient ?? removeSetupClient;
  const installAndEnableSemanticSearch =
    dependencies.installAndEnableSemanticSearch ??
    installAndEnableSemanticSearchByDefault;
  const disableSemanticSearch =
    dependencies.disableSemanticSearch ?? disableSemanticSearchByDefault;
  const clientOptions = {
    ...dependencies.clientOptions,
    serverCommand,
  };
  const installedDocs: string[] = [];
  const failedDocs: string[] = [];
  const configuredClients: string[] = [];
  const removedClients: string[] = [];
  const unchangedClients: string[] = [];
  const failedClients: string[] = [];
  const failedSemanticSearch: string[] = [];
  let selectedDocs: string[] = [];
  let selectedClients: SetupClientId[] = [];
  let providerSelectionInitialized = false;
  let selectableClients: SetupClientStatus[] = [];
  let semanticSearchEnabled: boolean;
  let selectedSemanticSearch: 'enable' | 'disable';
  let applyChanges = false;

  prompts.intro(SETUP_BANNER);
  try {
    semanticSearchEnabled = await (
      dependencies.readSemanticSearchEnabled ??
      readSemanticSearchEnabledByDefault
    )();
    selectedSemanticSearch = semanticSearchEnabled ? 'enable' : 'disable';
  } catch (error) {
    prompts.error(
      `Could not read Semantic Search configuration: ${errorMessage(error)}. Fix the configuration before running setup.`,
    );
    prompts.outro('Setup stopped before making changes.');
    return 1;
  }
  let catalogEntries: DocumentationCatalogEntry[] = [];
  let catalogReadable = true;
  try {
    catalogEntries = await listIndexes();
  } catch (error) {
    catalogReadable = false;
    failedDocs.push(`catalog: ${errorMessage(error)}`);
    prompts.error(
      `Could not read the documentation catalog: ${errorMessage(error)}`,
    );
  }

  const installedSelectors = new Set(
    catalogEntries
      .filter((entry) => entry.status === 'installed')
      .map((entry) => `${entry.source}@${entry.version}`),
  );
  const docChoices = recipes.map((recipe) => {
    const selector = recipe.selector;
    const installed = installedSelectors.has(selector);
    return {
      value: selector,
      label: selector,
      ...(installed && { hint: '✓' }),
      disabled: installed || !catalogReadable,
    };
  });
  const canChooseDocs =
    catalogReadable && docChoices.some((choice) => !choice.disabled);
  if (!catalogReadable) {
    prompts.message(
      'Documentation selection is unavailable; provider setup can continue.',
    );
  } else if (recipes.length === 0) {
    prompts.message('No curated documentation snapshots are available.');
  } else if (!canChooseDocs) {
    prompts.message(
      'All curated documentation snapshots are already installed.',
    );
  }
  let stage: 'docs' | 'clients' | 'semantic' | 'review' = canChooseDocs
    ? 'docs'
    : 'clients';
  const hasDocsStep = canChooseDocs;
  const stepCount = hasDocsStep ? 4 : 3;

  while (!applyChanges) {
    if (stage === 'docs') {
      prompts.message(`Step 1 of ${stepCount}: choose documentation snapshots`);
      const selection = await prompts.multiselect(
        'Select documentation (Space toggles, Enter continues)',
        docChoices,
        selectedDocs,
      );
      if (prompts.isBack(selection)) continue;
      if (prompts.isCancel(selection)) {
        prompts.cancel('Setup cancelled. No changes were made.');
        return 130;
      }
      const selectableDocs = new Set(
        docChoices
          .filter((choice) => !choice.disabled)
          .map(({ value }) => value),
      );
      selectedDocs = selection.filter((selector) =>
        selectableDocs.has(selector),
      );
      stage = 'clients';
      continue;
    }

    if (stage === 'clients') {
      prompts.message(
        `Step ${hasDocsStep ? '2' : '1'} of ${stepCount}: choose MCP providers`,
      );
      let inspectionFailed = false;
      try {
        selectableClients = await inspectClients(clientOptions);
      } catch (error) {
        const message = `Could not inspect MCP providers: ${errorMessage(error)}. Provider configuration was skipped.`;
        prompts.error(message);
        failedClients.push(message);
        selectableClients = [];
        inspectionFailed = true;
      }
      if (inspectionFailed) {
        selectedClients = [];
        stage = 'semantic';
        continue;
      }

      const visibleProviders = selectableClients.filter(isMenuProvider);
      const setupChoices = visibleProviders.filter(isSelectableProvider);
      if (!providerSelectionInitialized) {
        selectedClients = setupChoices
          .filter((client) => client.state === 'already-configured')
          .map(({ id }) => id);
        providerSelectionInitialized = true;
      }
      selectedClients = selectedClients.filter((id) =>
        setupChoices.some((client) => client.id === id),
      );
      const groups = buildClientGroups(visibleProviders);
      if (visibleProviders.length > 0) {
        const selection = await prompts.groupMultiselect(
          'Select providers for setup (uncheck configured providers to remove)',
          groups,
          selectedClients,
        );
        if (prompts.isBack(selection)) {
          stage = hasDocsStep ? 'docs' : 'clients';
          continue;
        }
        if (prompts.isCancel(selection)) {
          prompts.cancel('Setup cancelled. No changes were made.');
          return 130;
        }
        const selected = new Set(selection);
        selectedClients = setupChoices
          .filter((client) => selected.has(client.id))
          .map(({ id }) => id);
      } else {
        selectedClients = [];
        prompts.message(providerAvailabilityMessage(selectableClients));
      }
      stage = 'semantic';
      continue;
    }

    if (stage === 'semantic') {
      prompts.message(
        `Step ${hasDocsStep ? '3' : '2'} of ${stepCount}: Semantic Search`,
      );
      const selection = await prompts.select(
        'Enable Semantic Search? Qwen3-Embedding-0.6B download size: approximately 625 MB',
        [
          {
            value: 'enable',
            label: semanticSearchEnabled ? 'Keep enabled' : 'Install now',
            hint: 'Qwen3-Embedding-0.6B · approximately 625 MB',
          },
          {
            value: 'disable',
            label: semanticSearchEnabled ? 'Disable' : 'Skip for now',
            hint: 'Lexical Search stays available',
          },
        ],
        selectedSemanticSearch,
      );
      if (prompts.isBack(selection)) {
        stage = 'clients';
        continue;
      }
      if (prompts.isCancel(selection)) {
        prompts.cancel('Setup cancelled. No changes were made.');
        return 130;
      }
      selectedSemanticSearch = selection;
      stage = 'review';
      continue;
    }

    const selectedClientIds = new Set(selectedClients);
    const hasProviderChanges = selectableClients.some(
      (client) =>
        (client.state === 'ready' && selectedClientIds.has(client.id)) ||
        (client.state === 'already-configured' &&
          !selectedClientIds.has(client.id)),
    );
    const hasSemanticSearchChange =
      (selectedSemanticSearch === 'enable') !== semanticSearchEnabled;
    if (
      selectedDocs.length === 0 &&
      !hasProviderChanges &&
      !hasSemanticSearchChange
    )
      break;
    prompts.message(
      `Step ${hasDocsStep ? '4' : '3'} of ${stepCount}: review and confirm`,
    );
    prompts.message(
      renderConfigurationPreview(
        selectedDocs,
        selectedClients,
        selectableClients,
        selectedSemanticSearch,
        semanticSearchEnabled,
      ),
    );
    const approved = await prompts.confirm(
      'Proceed with these changes? (Backspace returns to provider selection)',
    );
    if (prompts.isBack(approved)) {
      stage = 'clients';
      continue;
    }
    if (prompts.isCancel(approved) || !approved) {
      prompts.cancel('Setup cancelled. No changes were made.');
      return 130;
    }
    applyChanges = true;
  }

  if (applyChanges) {
    const finalSelectedClientIds = new Set(selectedClients);
    if (selectedSemanticSearch === 'disable' && semanticSearchEnabled) {
      const spinner = prompts.spinner(isPlainProgressTerminal(terminal));
      spinner.start('Disabling Semantic Search');
      try {
        await disableSemanticSearch();
        semanticSearchEnabled = false;
        spinner.stop(
          'Disabled Semantic Search; model and existing embeddings were preserved',
        );
      } catch (error) {
        const message = `Could not disable Semantic Search: ${errorMessage(error)}`;
        failedSemanticSearch.push(message);
        spinner.error(message);
      }
    } else if (selectedSemanticSearch === 'enable' && !semanticSearchEnabled) {
      const spinner = prompts.spinner(isPlainProgressTerminal(terminal));
      spinner.start('Installing Qwen3 and enabling Semantic Search');
      try {
        await installAndEnableSemanticSearch((message) =>
          spinner.message(message),
        );
        semanticSearchEnabled = true;
        spinner.stop('Qwen3 installed; Semantic Search enabled');
      } catch (error) {
        const message = `Could not enable Semantic Search: ${errorMessage(error)}`;
        failedSemanticSearch.push(message);
        spinner.error(message);
      }
    }

    for (const selector of selectedDocs) {
      const [source, version] = splitSelector(selector);
      const spinner = prompts.spinner(isPlainProgressTerminal(terminal));
      spinner.start(`${selector}: installing snapshot`);
      try {
        await install(source, version, 'add', {
          onProgress: (phase) =>
            spinner.message(`${selector}: ${phaseLabel(phase)}`),
        });
        spinner.stop(`Installed ${selector}`);
        installedDocs.push(selector);
      } catch (error) {
        const message = `Could not install ${selector}: ${errorMessage(error)}`;
        spinner.error(message);
        failedDocs.push(message);
      }
    }

    for (const id of selectedClients) {
      const client = selectableClients.find((entry) => entry.id === id);
      const label = client?.label ?? id;
      if (client?.state === 'already-configured') continue;
      const spinner = prompts.spinner(isPlainProgressTerminal(terminal));
      spinner.start(`Configuring ${label}`);
      try {
        const result = await configureClient(id, clientOptions);
        if (result === 'added') {
          configuredClients.push(label);
          spinner.stop(`Configured ${label}`);
        } else {
          unchangedClients.push(label);
          spinner.stop(`${label} is already configured`);
        }
      } catch (error) {
        const message = `Could not configure ${label}: ${errorMessage(error)}`;
        failedClients.push(message);
        spinner.error(message);
      }
    }

    for (const client of selectableClients) {
      if (
        client.state !== 'already-configured' ||
        finalSelectedClientIds.has(client.id)
      ) {
        continue;
      }
      const spinner = prompts.spinner(isPlainProgressTerminal(terminal));
      spinner.start(`Removing ${client.label}`);
      try {
        const result = await removeClient(client.id, clientOptions);
        if (result === 'removed') {
          removedClients.push(client.label);
          spinner.stop(`Removed ${client.label}`);
        } else {
          spinner.stop(`${client.label} was already unconfigured`);
        }
      } catch (error) {
        const message = `Could not remove ${client.label}: ${errorMessage(error)}`;
        failedClients.push(message);
        spinner.error(message);
      }
    }
  }

  prompts.outro(
    renderSummary({
      installedDocs,
      failedDocs,
      configuredClients,
      removedClients,
      keptClients: selectableClients
        .filter(
          (client) =>
            client.state === 'already-configured' &&
            selectedClients.includes(client.id),
        )
        .map(({ label }) => label),
      unchangedClients,
      failedClients,
      semanticSearchEnabled,
      failedSemanticSearch,
      applyChanges,
    }),
  );
  return failedDocs.length > 0 ||
    failedClients.length > 0 ||
    failedSemanticSearch.length > 0
    ? 1
    : 0;
}

export function createSetupPromptApi(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  errorOutput: Writable = process.stderr,
  accessible?: boolean,
): SetupPromptApi {
  const isCancel = (value: unknown): value is symbol => clack.isCancel(value);
  const promptOptions = {
    input,
    output,
    ...(accessible !== undefined && { accessible }),
  };
  const withBackspace = async <T>(
    prompt: (signal: AbortSignal) => Promise<T | symbol>,
  ): Promise<T | symbol> => promptWithBackspace(input, prompt);
  return {
    intro: (message) =>
      clack.intro(styleText('bold', message), {
        output,
        withGuide: false,
        ...(accessible !== undefined && { accessible }),
      }),
    message: (message) => clack.log.message(message, promptOptions),
    error: (message) =>
      clack.log.error(message, {
        ...promptOptions,
        output: errorOutput,
      }),
    outro: (message) => clack.outro(message, promptOptions),
    isCancel,
    isBack: (value) => value === SETUP_BACK,
    multiselect: <T extends string>(
      message: string,
      options: SetupChoice<T>[],
      initialValues?: readonly T[],
    ) =>
      withBackspace((signal) =>
        withDynamicMultiselectInstructions(input, options, initialValues, () =>
          clack.multiselect<T>({
            message,
            options: options as unknown as Parameters<
              typeof clack.multiselect<T>
            >[0]['options'],
            input,
            output,
            ...(accessible !== undefined && { accessible }),
            initialValues,
            required: false,
            showInstructions: true,
            signal,
          }),
        ),
      ),
    groupMultiselect: <T extends string>(
      message: string,
      groups: SetupGroupedChoices<T>,
      initialValues?: readonly T[],
    ) =>
      withBackspace((signal) =>
        withDynamicGroupMultiselectInstructions(
          input,
          groups,
          initialValues,
          () =>
            clack.groupMultiselect<T>({
              message,
              options: groups as unknown as Parameters<
                typeof clack.groupMultiselect<T>
              >[0]['options'],
              input,
              output,
              ...(accessible !== undefined && { accessible }),
              ...(initialValues && { initialValues: [...initialValues] }),
              required: false,
              selectableGroups: true,
              groupSpacing: 1,
              showInstructions: true,
              signal,
            }),
        ),
      ),
    select: <T extends string>(
      message: string,
      options: SetupChoice<T>[],
      initialValue?: T,
    ) =>
      withBackspace((signal) =>
        clack.select<T>({
          message,
          options: options as unknown as Parameters<
            typeof clack.select<T>
          >[0]['options'],
          input,
          output,
          ...(accessible !== undefined && { accessible }),
          ...(initialValue !== undefined && { initialValue }),
          signal,
        }),
      ),
    confirm: (message) =>
      withBackspace((signal) =>
        clack.confirm({ message, ...promptOptions, signal }),
      ),
    spinner: (plain) => {
      if (plain) {
        const write = (message: string): void => {
          errorOutput.write(`${message}\n`);
        };
        return {
          start: write,
          message: write,
          stop: write,
          error: write,
        };
      }
      const spinner = clack.spinner({
        output: errorOutput,
        ...(accessible !== undefined && { accessible }),
      });
      return {
        start: (message) => spinner.start(message),
        message: (message) => spinner.message(message),
        stop: (message) => spinner.stop(message),
        error: (message) => spinner.error(message),
      };
    },
    cancel: (message) =>
      clack.cancel(message, {
        output: errorOutput,
        ...(accessible !== undefined && { accessible }),
      }),
  };
}

function renderSummary(summary: {
  installedDocs: string[];
  failedDocs: string[];
  configuredClients: string[];
  removedClients: string[];
  keptClients: string[];
  unchangedClients: string[];
  failedClients: string[];
  semanticSearchEnabled: boolean;
  failedSemanticSearch: string[];
  applyChanges: boolean;
}): string {
  const lines = [
    summary.applyChanges
      ? 'Setup finished.'
      : 'Setup finished with no changes.',
    `Documentation installed: ${listOrNone(summary.installedDocs)}`,
    `Documentation failures: ${listOrNone(summary.failedDocs)}`,
    `Providers configured: ${listOrNone(summary.configuredClients)}`,
    `Providers removed: ${listOrNone(summary.removedClients)}`,
    `Providers kept configured: ${listOrNone(summary.keptClients)}`,
    `Providers already configured: ${listOrNone(summary.unchangedClients)}`,
    `Provider failures: ${listOrNone(summary.failedClients)}`,
    `Semantic Search: ${summary.semanticSearchEnabled ? 'enabled' : 'disabled'}`,
    `Semantic Search failures: ${listOrNone(summary.failedSemanticSearch)}`,
  ];
  return lines.join('\n');
}

function isBulkConfigurableClient(client: SetupClientStatus): boolean {
  return (
    client.state === 'ready' &&
    client.application === 'detected' &&
    client.setupMode === 'automatic' &&
    ['available', 'missing', 'managed'].includes(client.configuration) &&
    client.registration === 'missing'
  );
}

function isSelectableProvider(client: SetupClientStatus): boolean {
  return (
    isBulkConfigurableClient(client) ||
    (client.state === 'already-configured' &&
      client.registration === 'configured' &&
      client.setupMode === 'automatic')
  );
}

function isMenuProvider(client: SetupClientStatus): boolean {
  return (
    client.setupMode === 'automatic' &&
    ['ready', 'already-configured', 'conflict'].includes(client.state)
  );
}

function providerAvailabilityMessage(clients: SetupClientStatus[]): string {
  if (clients.length === 0) return 'No supported MCP providers were detected.';
  const unsupported = clients.filter(
    (client) => client.state === 'unsupported',
  );
  if (unsupported.length > 0) {
    return `Detected MCP providers do not expose a supported inspection interface: ${unsupported.map(({ label }) => label).join(', ')}.`;
  }
  return 'No MCP providers are ready to configure.';
}

function buildClientGroups(
  clients: SetupClientStatus[],
): SetupGroupedChoices<SetupClientId> {
  if (clients.length === 0) return {};
  return {
    'MCP providers': clients.map((client) => ({
      value: client.id,
      label: client.label,
      hint: providerChoiceHint(client),
      disabled: client.state === 'conflict',
    })),
  };
}

function providerChoiceHint(client: SetupClientStatus): string {
  if (client.state === 'already-configured') return 'Already configured · User';
  if (client.state === 'conflict') {
    return `Conflict · ${client.reason ?? 'Registration is not owned by NekoSearch'}`;
  }
  return 'Available · User';
}

function renderConfigurationPreview(
  selectedDocs: string[],
  selectedClientIds: SetupClientId[],
  clients: SetupClientStatus[],
  selectedSemanticSearch: 'enable' | 'disable',
  semanticSearchEnabled: boolean,
): string {
  const selectedIds = new Set(selectedClientIds);
  const affectedClients = clients.filter(
    (client) =>
      (client.state === 'ready' && selectedIds.has(client.id)) ||
      client.state === 'already-configured',
  );
  const selectedClients = affectedClients
    .filter((client) => selectedIds.has(client.id))
    .map((client) => client);
  const removedClients = affectedClients.filter(
    (client) =>
      client.state === 'already-configured' && !selectedIds.has(client.id),
  );
  const lines = [
    'Changes to be applied',
    'Documentation:',
    ...selectedDocs.map((selector) => `  ${selector}`),
  ];
  if (selectedDocs.length === 0) lines.push('  none');
  lines.push('MCP clients:');
  if (selectedClients.length === 0 && removedClients.length === 0) {
    lines.push('  none');
  } else {
    for (const client of selectedClients) {
      lines.push(
        `  ${client.label}`,
        `    Scope: ${client.scope === 'user' ? 'User' : 'Project'}`,
        `    Target: ${client.target}`,
        `    Action: ${client.state === 'already-configured' ? 'Keep existing NekoSearch configuration' : 'Add NekoSearch'}`,
      );
    }
    for (const client of removedClients) {
      lines.push(
        `  ${client.label}`,
        `    Scope: ${client.scope === 'user' ? 'User' : 'Project'}`,
        `    Target: ${client.target}`,
        `    Action: Remove NekoSearch configuration`,
      );
    }
  }
  lines.push('Other provider settings will be preserved.');
  lines.push('Semantic Search:');
  if (selectedSemanticSearch === 'enable') {
    lines.push(
      semanticSearchEnabled
        ? '  keep enabled'
        : '  install Qwen3-Embedding-0.6B (~625 MB) and enable',
    );
  } else {
    lines.push(
      semanticSearchEnabled
        ? '  disable and preserve model and embeddings'
        : '  skip for now; keep disabled',
    );
  }
  return lines.join('\n');
}

async function readSemanticSearchEnabledByDefault(): Promise<boolean> {
  const semanticSearch = await import('./semantic-search.js');
  const configuration = await semanticSearch.loadSemanticSearchConfiguration();
  return configuration.enabled;
}

async function installAndEnableSemanticSearchByDefault(
  progress: (message: string) => void,
): Promise<void> {
  const modelManager = await import('./model-manager.js');
  const runtimeStatus = await modelManager.getModelStatus();
  if (!runtimeStatus.runtimeAvailable) {
    throw new Error(
      `The local inference runtime is unavailable. ${runtimeStatus.details.join(' ')} Runtime requirement: ${runtimeStatus.runtimeRequirement}. Run \`nekosearch model status\` to check readiness before setup downloads Qwen3.`,
    );
  }
  await modelManager.installModel({ progress });

  const embeddings = await import('./embeddings.js');
  await embeddings.buildDocumentationEmbeddings(undefined, {
    onProgress: ({ selector, phase, completedChunks, totalChunks }) => {
      if (phase === 'embedding') {
        progress(
          `${selector}: embedding ${completedChunks}/${totalChunks} chunks`,
        );
      } else if (phase === 'activated') {
        progress(`${selector}: embeddings validated and activated`);
      }
    },
  });

  const semanticSearch = await import('./semantic-search.js');
  await semanticSearch.enableSemanticSearch();
}

async function disableSemanticSearchByDefault(): Promise<void> {
  const semanticSearch = await import('./semantic-search.js');
  await semanticSearch.disableSemanticSearch();
}

function isPlainProgressTerminal(terminal: SetupTerminalState): boolean {
  return (
    terminal.term?.toLowerCase() === 'dumb' ||
    terminal.ci === true ||
    terminal.accessible === true
  );
}

function isEnvironmentFlag(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value !== '' &&
    value !== '0' &&
    value.toLowerCase() !== 'false'
  );
}

function accessibleEnvironmentPreference(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  return isEnvironmentFlag(value);
}

async function promptWithBackspace<T>(
  input: Readable,
  prompt: (signal: AbortSignal) => Promise<T | symbol>,
): Promise<T | symbol> {
  const controller = new AbortController();
  let goBack = false;
  const onKeypress = (_character: string, key: Key): void => {
    if (
      key.name === 'backspace' ||
      key.sequence === '\x7f' ||
      key.sequence === '\b'
    ) {
      goBack = true;
      controller.abort();
    }
  };
  emitKeypressEvents(input as NodeJS.ReadStream);
  input.on('keypress', onKeypress);
  try {
    const result = await prompt(controller.signal);
    return goBack ? SETUP_BACK : result;
  } finally {
    input.off('keypress', onKeypress);
  }
}

async function withDynamicMultiselectInstructions<T extends string>(
  input: Readable,
  options: SetupChoice<T>[],
  initialValues: readonly T[] | undefined,
  prompt: () => Promise<T[] | symbol>,
): Promise<T[] | symbol> {
  const instructions = clack.MULTISELECT_INSTRUCTIONS;
  const originalInstructions = [...instructions];
  const selected = new Set(initialValues ?? []);
  let cursor = firstEnabledOption(options);

  const updateInstructions = (): void => {
    const focused = options[cursor];
    const action =
      focused && selected.has(focused.value) ? 'unselect' : 'select';
    instructions.splice(
      0,
      instructions.length,
      originalInstructions[0] ?? `${styleText('dim', '↑/↓')} to navigate`,
      `${styleText('dim', 'Space:')} ${action}`,
      originalInstructions[2] ?? `${styleText('dim', 'Enter:')} confirm`,
      `${styleText('dim', 'Backspace:')} go back`,
    );
  };

  const onKeypress = (_character: string, key: Key): void => {
    if (key.name === 'up' || key.name === 'left') {
      cursor = moveOptionCursor(options, cursor, -1);
    } else if (key.name === 'down' || key.name === 'right') {
      cursor = moveOptionCursor(options, cursor, 1);
    } else if (key.name === 'space') {
      const focused = options[cursor];
      if (focused && !focused.disabled) {
        if (selected.has(focused.value)) selected.delete(focused.value);
        else selected.add(focused.value);
      }
    } else if (key.name === 'a') {
      const enabled = options.filter((option) => !option.disabled);
      if (selected.size === enabled.length) {
        for (const option of enabled) selected.delete(option.value);
      } else {
        for (const option of enabled) selected.add(option.value);
      }
    } else if (key.name === 'i') {
      const inverted = options
        .filter((option) => !option.disabled && !selected.has(option.value))
        .map((option) => option.value);
      selected.clear();
      for (const value of inverted) selected.add(value);
    } else {
      return;
    }
    updateInstructions();
  };

  input.on('keypress', onKeypress);
  updateInstructions();
  try {
    return await prompt();
  } finally {
    input.off('keypress', onKeypress);
    instructions.splice(0, instructions.length, ...originalInstructions);
  }
}

async function withDynamicGroupMultiselectInstructions<T extends string>(
  input: Readable,
  groups: SetupGroupedChoices<T>,
  initialValues: readonly T[] | undefined,
  prompt: () => Promise<T[] | symbol>,
): Promise<T[] | symbol> {
  const instructions = clack.MULTISELECT_INSTRUCTIONS;
  const originalInstructions = [...instructions];
  const selected = new Set(initialValues ?? []);
  const options = Object.entries(groups).flatMap(([group, choices]) => [
    {
      value: group,
      label: group,
      group: true as const,
      choices,
      disabled: choices.every((choice) => choice.disabled),
    },
    ...choices.map((choice) => ({ ...choice, group })),
  ]);
  let cursor = 0;

  const updateInstructions = (): void => {
    const focused = options[cursor];
    let action = 'unavailable';
    if (focused?.group === true) {
      const enabled = focused.choices.filter((choice) => !choice.disabled);
      if (enabled.length > 0) {
        action = enabled.every((choice) => selected.has(choice.value))
          ? 'unselect group'
          : 'select group';
      }
    } else if (focused && !focused.disabled) {
      action = selected.has(focused.value) ? 'unselect' : 'select';
    }
    instructions.splice(
      0,
      instructions.length,
      originalInstructions[0] ?? `${styleText('dim', '↑/↓')} to navigate`,
      `${styleText('dim', 'Space:')} ${action}`,
      originalInstructions[2] ?? `${styleText('dim', 'Enter:')} confirm`,
      `${styleText('dim', 'Backspace:')} go back`,
    );
  };

  const onKeypress = (_character: string, key: Key): void => {
    if (key.name === 'up' || key.name === 'left') {
      cursor = moveGroupCursor(options.length, cursor, -1);
    } else if (key.name === 'down' || key.name === 'right') {
      cursor = moveGroupCursor(options.length, cursor, 1);
    } else if (key.name === 'space') {
      const focused = options[cursor];
      if (focused?.group === true) {
        const enabled = focused.choices.filter((choice) => !choice.disabled);
        const fullySelected =
          enabled.length > 0 &&
          enabled.every((choice) => selected.has(choice.value));
        for (const choice of enabled) {
          if (fullySelected) selected.delete(choice.value);
          else selected.add(choice.value);
        }
      } else if (focused && !focused.disabled) {
        if (selected.has(focused.value)) selected.delete(focused.value);
        else selected.add(focused.value);
      }
    } else {
      return;
    }
    updateInstructions();
  };

  input.on('keypress', onKeypress);
  updateInstructions();
  try {
    return await prompt();
  } finally {
    input.off('keypress', onKeypress);
    instructions.splice(0, instructions.length, ...originalInstructions);
  }
}

function moveGroupCursor(
  optionCount: number,
  cursor: number,
  direction: -1 | 1,
): number {
  if (optionCount === 0) return cursor;
  return (cursor + direction + optionCount) % optionCount;
}

function firstEnabledOption<T extends string>(
  options: SetupChoice<T>[],
): number {
  const firstEnabled = options.findIndex((option) => !option.disabled);
  return firstEnabled < 0 ? 0 : firstEnabled;
}

function moveOptionCursor<T extends string>(
  options: SetupChoice<T>[],
  cursor: number,
  direction: -1 | 1,
): number {
  if (options.length === 0) return cursor;
  let candidate = cursor;
  for (let index = 0; index < options.length; index += 1) {
    candidate = (candidate + direction + options.length) % options.length;
    if (!options[candidate]?.disabled) return candidate;
  }
  return cursor;
}

function phaseLabel(phase: RemoteSnapshotPhase): string {
  return {
    resolving: 'resolving the upstream ref',
    downloading: 'downloading documentation',
    indexing: 'building the local index',
    validating: 'validating the snapshot',
    installing: 'installing the snapshot',
  }[phase];
}

function splitSelector(selector: string): [string, string] {
  const separator = selector.lastIndexOf('@');
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(`Invalid curated selector ${selector}`);
  }
  return [selector.slice(0, separator), selector.slice(separator + 1)];
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join('; ') : 'none';
}

function defaultWriteOutput(
  message: string,
  stream: 'stdout' | 'stderr',
): void {
  (stream === 'stdout' ? process.stdout : process.stderr).write(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
