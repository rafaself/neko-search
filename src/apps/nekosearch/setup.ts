import * as clack from '@clack/prompts';
import { fileURLToPath } from 'node:url';
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
  getManualSetupInstructions,
  inspectSetupClients,
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

export interface SetupSpinner {
  start(message: string): void;
  stop(message: string): void;
}

export interface SetupPromptApi {
  intro(message: string): void;
  message(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  outro(message: string): void;
  isCancel(value: unknown): value is symbol;
  select<T extends string>(
    message: string,
    options: SetupChoice<T>[],
  ): Promise<T | symbol>;
  multiselect<T extends string>(
    message: string,
    options: SetupChoice<T>[],
  ): Promise<T[] | symbol>;
  confirm(message: string): Promise<boolean | symbol>;
  spinner(plain: boolean): SetupSpinner;
  cancel(message: string): void;
}

export interface SetupTerminalState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  term?: string;
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
  manualInstructions?: typeof getManualSetupInstructions;
  clientOptions?: Omit<SetupClientOptions, 'serverCommand'>;
}

type ClientAction = 'all-detected' | 'choose' | 'manual' | 'skip';

const CLIENT_ACTIONS: SetupChoice<ClientAction>[] = [
  { value: 'all-detected', label: 'Select all detected clients' },
  { value: 'choose', label: 'Choose clients' },
  { value: 'manual', label: 'Show manual setup instructions' },
  { value: 'skip', label: 'Skip client setup' },
];

/** Interactive first-run setup. The CLI imports this module only for `setup`. */
export async function runSetup(
  dependencies: SetupDependencies = {},
): Promise<number> {
  const terminal = dependencies.terminal ?? {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    term: process.env.TERM,
  };
  const output = dependencies.writeOutput ?? defaultWriteOutput;
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    output(
      [
        'nekosearch setup needs an interactive terminal and made no changes.',
        'Re-run `nekosearch setup` in a terminal, or install docs with `nekosearch add --dir` / `nekosearch add nestjs@12` and configure a client manually.',
      ].join('\n') + '\n',
      'stderr',
    );
    return 2;
  }

  const prompts = dependencies.prompts ?? createClackPrompts();
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
  const manualInstructions =
    dependencies.manualInstructions ?? getManualSetupInstructions;
  const clientOptions = {
    ...dependencies.clientOptions,
    serverCommand,
  };
  const installedDocs: string[] = [];
  const failedDocs: string[] = [];
  const configuredClients: string[] = [];
  const failedClients: string[] = [];
  const manuallyShown: string[] = [];
  let skippedDocs = false;
  let skippedClients = false;
  let cancelled = false;

  prompts.intro('NekoSearch setup');
  prompts.message('Step 1 of 2: choose documentation snapshots');
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
      label: installed ? `${selector} — already installed` : selector,
      hint: installed
        ? 'use `nekosearch update` to update it explicitly'
        : 'download and build this snapshot',
      disabled: installed || !catalogReadable,
    };
  });
  const selectedDocs = await prompts.multiselect(
    'Select curated documentation sources to install (space to select, enter to continue)',
    docChoices,
  );
  if (prompts.isCancel(selectedDocs)) {
    prompts.cancel('Setup cancelled. No documentation was installed.');
    cancelled = true;
  } else {
    const selected = selectedDocs.length > 0 ? selectedDocs : [];
    skippedDocs = selected.length === 0;
    for (const selector of selected) {
      const [source, version] = splitSelector(selector);
      let activeSpinner: SetupSpinner | undefined;
      let activePhase: RemoteSnapshotPhase | undefined;
      const onProgress = (phase: RemoteSnapshotPhase): void => {
        if (activeSpinner && activePhase) {
          activeSpinner.stop(
            `${selector}: ${phaseLabel(activePhase)} complete`,
          );
        }
        activeSpinner = prompts.spinner(terminal.term === 'dumb');
        activePhase = phase;
        activeSpinner.start(`${selector}: ${phaseLabel(phase)}`);
      };
      try {
        await install(source, version, 'add', { onProgress });
        activeSpinner?.stop(`Installed ${selector}`);
        installedDocs.push(selector);
        prompts.success(`Installed ${selector}`);
      } catch (error) {
        activeSpinner?.stop(`Failed to install ${selector}`);
        failedDocs.push(`${selector}: ${errorMessage(error)}`);
        prompts.error(`Could not install ${selector}: ${errorMessage(error)}`);
      }
    }
  }

  prompts.message('Step 2 of 2: choose MCP clients');
  let clientStatuses: SetupClientStatus[] = [];
  try {
    clientStatuses = await inspectClients(clientOptions);
  } catch (error) {
    prompts.error(`Could not inspect MCP clients: ${errorMessage(error)}`);
  }
  for (const client of clientStatuses) {
    prompts.message(
      `${client.label}: ${client.state}${client.reason ? ` — ${client.reason}` : ''}`,
    );
  }

  if (!cancelled) {
    const action = await prompts.select(
      'How would you like to continue?',
      CLIENT_ACTIONS,
    );
    if (prompts.isCancel(action)) {
      prompts.cancel('Setup cancelled.');
      cancelled = true;
    } else if (action === 'skip') {
      skippedClients = true;
    } else if (action === 'manual') {
      const manualChoices = clientStatuses.map((client) => ({
        value: client.id,
        label: `${client.label} — ${client.state}`,
        hint: client.automatic
          ? 'show manual configuration'
          : 'manual-only integration',
      }));
      const selectedManual = await prompts.multiselect(
        'Choose clients for manual setup instructions',
        manualChoices,
      );
      if (prompts.isCancel(selectedManual)) {
        prompts.cancel('Setup cancelled.');
        cancelled = true;
      } else if (selectedManual.length === 0) {
        skippedClients = true;
      } else {
        for (const id of selectedManual) {
          prompts.message(manualInstructions(id, clientOptions));
          manuallyShown.push(id);
        }
      }
    } else {
      const detected = clientStatuses.filter(
        (client) => client.automatic && client.state === 'available',
      );
      let selectedClients: SetupClientId[];
      if (action === 'all-detected') {
        selectedClients = detected.map((client) => client.id);
      } else {
        const choices = clientStatuses.map((client) => ({
          value: client.id,
          label: `${client.label} — ${client.state}`,
          hint: client.reason,
          disabled: !client.automatic || client.state !== 'available',
        }));
        const selection = await prompts.multiselect(
          'Select detected clients to configure',
          choices,
        );
        if (prompts.isCancel(selection)) {
          prompts.cancel('Setup cancelled.');
          cancelled = true;
          selectedClients = [];
        } else {
          selectedClients = selection.filter((id) =>
            clientStatuses.some(
              (client) =>
                client.id === id &&
                client.automatic &&
                client.state === 'available',
            ),
          );
        }
      }

      if (!cancelled && selectedClients.length === 0) {
        skippedClients = true;
        if (action === 'all-detected')
          prompts.warning('No detected clients are available to configure.');
      } else if (!cancelled) {
        const labels = selectedClients
          .map(
            (id) =>
              clientStatuses.find((client) => client.id === id)?.label ?? id,
          )
          .join(', ');
        const approved = await prompts.confirm(
          `Configure NekoSearch in: ${labels}?`,
        );
        if (prompts.isCancel(approved)) {
          prompts.cancel('Setup cancelled. No client settings were written.');
          cancelled = true;
        } else if (!approved) {
          skippedClients = true;
        } else {
          for (const id of selectedClients) {
            const client = clientStatuses.find(
              (candidate) => candidate.id === id,
            );
            try {
              const result = await configureClient(id, clientOptions);
              if (result === 'added') configuredClients.push(id);
              else if (client) client.state = 'already configured';
            } catch (error) {
              failedClients.push(
                `${client?.label ?? id}: ${errorMessage(error)}`,
              );
              prompts.error(
                `Could not configure ${client?.label ?? id}: ${errorMessage(error)}`,
              );
            }
          }
        }
      }
    }
  } else {
    skippedClients = true;
  }

  const conflictLabels = clientStatuses
    .filter((client) => client.state === 'conflict')
    .map((client) => client.label);
  const alreadyConfigured = clientStatuses
    .filter((client) => client.state === 'already configured')
    .map((client) => client.label);
  prompts.outro(
    renderSummary({
      installedDocs,
      failedDocs,
      configuredClients,
      failedClients,
      alreadyConfigured,
      conflictLabels,
      manuallyShown,
      skippedDocs,
      skippedClients,
      cancelled,
    }),
  );
  return failedDocs.length > 0 || failedClients.length > 0
    ? 1
    : cancelled
      ? 130
      : 0;
}

function createClackPrompts(): SetupPromptApi {
  const isCancel = (value: unknown): value is symbol => clack.isCancel(value);
  return {
    intro: (message) => clack.intro(message),
    message: (message) => clack.log.message(message),
    success: (message) => clack.log.success(message),
    warning: (message) => clack.log.warn(message),
    error: (message) => clack.log.error(message),
    outro: (message) => clack.outro(message),
    isCancel,
    select: <T extends string>(message: string, options: SetupChoice<T>[]) =>
      clack.select<T>({
        message,
        options: options as Parameters<typeof clack.select<T>>[0]['options'],
      }),
    multiselect: <T extends string>(
      message: string,
      options: SetupChoice<T>[],
    ) =>
      clack.multiselect<T>({
        message,
        options: options as unknown as Parameters<
          typeof clack.multiselect<T>
        >[0]['options'],
        required: false,
      }),
    confirm: (message) => clack.confirm({ message }),
    spinner: (plain) => {
      if (plain) {
        return {
          start: (message) => process.stderr.write(`${message}...\n`),
          stop: (message) => process.stderr.write(`${message}\n`),
        };
      }
      const spinner = clack.spinner();
      return {
        start: (message) => spinner.start(message),
        stop: (message) => spinner.stop(message),
      };
    },
    cancel: (message) => clack.cancel(message),
  };
}

function renderSummary(summary: {
  installedDocs: string[];
  failedDocs: string[];
  configuredClients: string[];
  failedClients: string[];
  alreadyConfigured: string[];
  conflictLabels: string[];
  manuallyShown: string[];
  skippedDocs: boolean;
  skippedClients: boolean;
  cancelled: boolean;
}): string {
  const lines = [summary.cancelled ? 'Setup stopped.' : 'Setup finished.'];
  lines.push(`Documentation installed: ${listOrNone(summary.installedDocs)}`);
  lines.push(`Documentation failures: ${listOrNone(summary.failedDocs)}`);
  lines.push(
    `MCP clients configured: ${listOrNone(summary.configuredClients)}`,
  );
  lines.push(`Already configured: ${listOrNone(summary.alreadyConfigured)}`);
  lines.push(`Conflicts left unchanged: ${listOrNone(summary.conflictLabels)}`);
  lines.push(`Manual instructions shown: ${listOrNone(summary.manuallyShown)}`);
  lines.push(
    `Skipped: ${[summary.skippedDocs && 'documentation', summary.skippedClients && 'client setup'].filter(Boolean).join(', ') || 'none'}`,
  );
  lines.push(`Client setup failures: ${listOrNone(summary.failedClients)}`);
  return lines.join('\n');
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
