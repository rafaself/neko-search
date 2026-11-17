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

export interface SetupSpinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export const SETUP_BACK = Symbol('setup-back');

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
  clientOptions?: Omit<SetupClientOptions, 'serverCommand'>;
}

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
        'Re-run `nekosearch setup` in a terminal, or install docs with `nekosearch add --dir` / `nekosearch add nestjs@12` and configure an available provider.',
      ].join('\n') + '\n',
      'stderr',
    );
    return 2;
  }

  const prompts = dependencies.prompts ?? createSetupPromptApi();
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
  let stage: 'docs' | 'clients' | 'review' = 'docs';
  let cancelled = false;
  let applyChanges = false;

  prompts.intro('NekoSearch setup');
  prompts.message('Step 1 of 3: choose documentation snapshots');
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
      disabled: installed || !catalogReadable,
    };
  });

  while (!cancelled && !applyChanges) {
    if (stage === 'docs') {
      const selection = await prompts.multiselect(
        'Select documentation (Space toggles, Enter continues)',
        docChoices,
        selectedDocs,
      );
      if (prompts.isBack(selection)) continue;
      if (prompts.isCancel(selection)) {
        prompts.cancel('Setup cancelled. No changes were made.');
        cancelled = true;
        continue;
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
      prompts.message('Step 2 of 3: choose MCP providers');
      try {
        selectableClients = await inspectClients(clientOptions);
      } catch (error) {
        failedClients.push(`provider discovery: ${errorMessage(error)}`);
        selectableClients = [];
      }
      const selectableIds = new Set(selectableClients.map(({ id }) => id));
      selectedClients = selectedClients.filter((id) => selectableIds.has(id));

      if (selectableClients.length === 0) {
        prompts.message('No supported MCP providers were detected.');
        const continueToReview = await prompts.confirm(
          'Continue to review? (Backspace returns to documentation)',
        );
        if (prompts.isBack(continueToReview) || continueToReview === false) {
          stage = 'docs';
          continue;
        }
        if (prompts.isCancel(continueToReview)) {
          prompts.cancel('Setup cancelled. No changes were made.');
          cancelled = true;
          continue;
        }
        stage = 'review';
        continue;
      }

      const selection = await prompts.multiselect(
        'Select providers (Space toggles, Enter continues; Backspace returns to documentation)',
        selectableClients.map(
          ({ id, label, alreadyConfigured, requiresReplacement }) => ({
            value: id,
            label,
            ...(alreadyConfigured && { hint: 'already configured' }),
            ...(requiresReplacement && {
              hint: 'replace existing NekoSearch registration',
            }),
          }),
        ),
        selectedClients,
      );
      if (prompts.isBack(selection)) {
        stage = 'docs';
        continue;
      }
      if (prompts.isCancel(selection)) {
        prompts.cancel('Setup cancelled. No changes were made.');
        cancelled = true;
        continue;
      }
      selectedClients = selection.filter((id) => selectableIds.has(id));
      stage = 'review';
      continue;
    }

    prompts.message('Step 3 of 3: review');
    prompts.message(`Documentation to install: ${listOrNone(selectedDocs)}`);
    prompts.message(
      `Providers to configure: ${listOrNone(
        selectedClients.map((id) => {
          const client = selectableClients.find((entry) => entry.id === id);
          if (client?.requiresReplacement)
            return `${client.label} (replace existing NekoSearch registration)`;
          if (client?.alreadyConfigured)
            return `${client.label} (already configured)`;
          return client?.label ?? id;
        }),
      )}`,
    );
    const approved = await prompts.confirm(
      'Confirm and apply these changes? (Backspace returns to provider selection)',
    );
    if (prompts.isBack(approved)) {
      stage = 'clients';
      continue;
    }
    if (prompts.isCancel(approved) || !approved) {
      prompts.cancel('Setup cancelled. No changes were made.');
      cancelled = true;
      continue;
    }
    applyChanges = true;
  }

  if (applyChanges) {
    for (const selector of selectedDocs) {
      const [source, version] = splitSelector(selector);
      const spinner = prompts.spinner(terminal.term === 'dumb');
      spinner.start(`${selector}: preparing snapshot`);
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
      const replacing = client?.requiresReplacement === true;
      const spinner = prompts.spinner(terminal.term === 'dumb');
      spinner.start(
        replacing ? `Replacing ${label} registration` : `Configuring ${label}`,
      );
      try {
        const result = await configureClient(id, {
          ...clientOptions,
          ...(replacing && { replaceConflictingCodex: true }),
        });
        if (result === 'added') {
          configuredClients.push(label);
          spinner.stop(
            replacing
              ? `Replaced ${label} registration`
              : `Configured ${label}`,
          );
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
      cancelled,
      applyChanges,
    }),
  );
  return failedDocs.length > 0 || failedClients.length > 0
    ? 1
    : cancelled
      ? 130
      : 0;
}

export function createSetupPromptApi(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): SetupPromptApi {
  const isCancel = (value: unknown): value is symbol => clack.isCancel(value);
  const withBackspace = async <T>(
    prompt: (signal: AbortSignal) => Promise<T | symbol>,
  ): Promise<T | symbol> => promptWithBackspace(input, prompt);
  return {
    intro: (message) => clack.intro(styleText('bold', message)),
    message: (message) => clack.log.message(message),
    error: (message) => clack.log.error(message),
    outro: (message) => clack.outro(message),
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
            initialValues,
            required: false,
            showInstructions: true,
            signal,
          }),
        ),
      ),
    confirm: (message) =>
      withBackspace((signal) =>
        clack.confirm({ message, input, output, signal }),
      ),
    spinner: (plain) => {
      if (plain) {
        return {
          start: (message) => process.stderr.write(message),
          message: (message) => process.stderr.write(`\r${message}`),
          stop: (message) => process.stderr.write(`\r${message}\n`),
          error: (message) => process.stderr.write(`\r${message}\n`),
        };
      }
      const spinner = clack.spinner();
      return {
        start: (message) => spinner.start(message),
        message: (message) => spinner.message(message),
        stop: (message) => spinner.stop(message),
        error: (message) => spinner.error(message),
      };
    },
    cancel: (message) => clack.cancel(message),
  };
}

function renderSummary(summary: {
  installedDocs: string[];
  failedDocs: string[];
  configuredClients: string[];
  unchangedClients: string[];
  failedClients: string[];
  cancelled: boolean;
  applyChanges: boolean;
}): string {
  const lines = [
    summary.cancelled
      ? 'Setup cancelled. No changes were made.'
      : summary.applyChanges
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
