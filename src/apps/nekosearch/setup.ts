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
  const clientOptions = {
    ...dependencies.clientOptions,
    serverCommand,
  };
  const installedDocs: string[] = [];
  const failedDocs: string[] = [];
  const configuredClients: string[] = [];
  const unchangedClients: string[] = [];
  const failedClients: string[] = [];
  let selectedDocs: string[] = [];
  let selectedClients: SetupClientId[] = [];
  let selectableClients: SetupClientStatus[] = [];
  let applyChanges = false;

  prompts.intro(SETUP_BANNER);
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
  let stage: 'docs' | 'clients' | 'review' = canChooseDocs ? 'docs' : 'clients';
  const hasDocsStep = canChooseDocs;

  while (!applyChanges) {
    if (stage === 'docs') {
      prompts.message('Step 1 of 3: choose documentation snapshots');
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
        `Step ${hasDocsStep ? '2 of 3' : '1 of 2'}: choose MCP providers`,
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
        stage = 'review';
        continue;
      }

      const readyClients = selectableClients.filter(isBulkConfigurableClient);
      const alreadyConfigured = selectableClients.filter(
        (client) => client.state === 'already-configured',
      );
      if (alreadyConfigured.length > 0) {
        prompts.message(
          [
            'Already configured:',
            ...alreadyConfigured.map((client) => `  ✓ ${client.label}`),
          ].join('\n'),
        );
      }
      const groups = buildClientGroups(readyClients);
      if (readyClients.length > 0) {
        const selection = await prompts.groupMultiselect(
          'Select providers to configure (Space toggles; Enter continues)',
          groups,
          selectedClients.filter((id) =>
            readyClients.some((client) => client.id === id),
          ),
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
        selectedClients = readyClients
          .filter((client) => selected.has(client.id))
          .map(({ id }) => id);
      } else {
        selectedClients = [];
        if (alreadyConfigured.length === 0) {
          prompts.message(
            selectableClients.length === 0
              ? 'No supported MCP providers were detected.'
              : 'No MCP providers are ready to configure.',
          );
        }
      }
      stage = 'review';
      continue;
    }

    if (selectedDocs.length === 0 && selectedClients.length === 0) break;
    prompts.message(
      `Step ${hasDocsStep ? '3 of 3' : '2 of 2'}: review and confirm`,
    );
    prompts.message(
      renderConfigurationPreview(
        selectedDocs,
        selectedClients,
        selectableClients,
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
  }

  prompts.outro(
    renderSummary({
      installedDocs,
      failedDocs,
      configuredClients,
      unchangedClients,
      failedClients,
      applyChanges,
    }),
  );
  return failedDocs.length > 0 || failedClients.length > 0 ? 1 : 0;
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
  unchangedClients: string[];
  failedClients: string[];
  applyChanges: boolean;
}): string {
  const lines = [
    summary.applyChanges
      ? 'Setup finished.'
      : 'Setup finished with no changes.',
    `Documentation installed: ${listOrNone(summary.installedDocs)}`,
    `Documentation failures: ${listOrNone(summary.failedDocs)}`,
    `Providers configured: ${listOrNone(summary.configuredClients)}`,
    `Providers already configured: ${listOrNone(summary.unchangedClients)}`,
    `Provider failures: ${listOrNone(summary.failedClients)}`,
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

function buildClientGroups(
  clients: SetupClientStatus[],
): SetupGroupedChoices<SetupClientId> {
  const readyClients = clients.filter(isBulkConfigurableClient);
  if (readyClients.length === 0) return {};
  return {
    'Ready to configure': readyClients.map((client) => ({
      value: client.id,
      label: client.label,
      hint: client.scope === 'user' ? 'User' : 'Project',
    })),
  };
}

function renderConfigurationPreview(
  selectedDocs: string[],
  selectedClientIds: SetupClientId[],
  clients: SetupClientStatus[],
): string {
  const selectedClients = selectedClientIds
    .map((id) => clients.find((client) => client.id === id))
    .filter((client): client is SetupClientStatus => client !== undefined);
  const lines = [
    'Changes to be applied',
    'Documentation:',
    ...selectedDocs.map((selector) => `  ${selector}`),
  ];
  if (selectedDocs.length === 0) lines.push('  none');
  lines.push('MCP clients:');
  if (selectedClients.length === 0) {
    lines.push('  none');
  } else {
    for (const client of selectedClients) {
      lines.push(
        `  ${client.label}`,
        `    Scope: ${client.scope === 'user' ? 'User' : 'Project'}`,
        `    Target: ${client.target}`,
        `    Action: Add NekoSearch`,
      );
    }
  }
  lines.push('Existing configurations will be preserved.');
  return lines.join('\n');
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
