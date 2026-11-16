import {
  getCatalogIndex,
  readCatalogOverview,
  type DocumentationCatalogEntry,
} from './catalog.js';
import { PACKAGE_VERSION } from '../../shared/config/package-metadata.js';
import {
  checkUpstreamRevisions,
  getSnapshotTrackingState,
  type UpstreamRevisionResult,
} from './remote-snapshots.js';
import type { RemoteSnapshotOptions } from './remote-snapshots.js';

export interface StatusArguments {
  selector?: string;
  checkUpstream: boolean;
}

export function parseStatusArguments(arguments_: string[]): StatusArguments {
  let selector: string | undefined;
  let checkUpstream = false;
  for (const argument of arguments_) {
    if (argument === '--check-upstream') {
      if (checkUpstream) throw new Error('Specify --check-upstream only once');
      checkUpstream = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown status option: ${argument}`);
    } else if (selector === undefined) {
      selector = argument;
    } else {
      throw new Error('Status accepts at most one source@version selector');
    }
  }
  if (selector !== undefined) {
    const separator = selector.lastIndexOf('@');
    if (separator <= 0 || separator === selector.length - 1) {
      throw new Error(
        `Invalid source selector "${selector}"; use the form source@version`,
      );
    }
  }
  return { ...(selector && { selector }), checkUpstream };
}

/** Render catalog status, checking upstream refs only when explicitly requested. */
export async function renderStatus(
  input: StatusArguments,
  options: RemoteSnapshotOptions = {},
): Promise<{ text: string; exitCode: number }> {
  let entries: DocumentationCatalogEntry[];
  let header: string;
  let readable = true;
  let errors: string[] = [];
  if (input.selector !== undefined) {
    let selected: DocumentationCatalogEntry | undefined;
    try {
      selected = await getCatalogIndex(input.selector, options);
    } catch (error) {
      return {
        text: `NekoSearch version: ${PACKAGE_VERSION}\nSnapshot: unreadable\n${errorMessage(error)}\n`,
        exitCode: 1,
      };
    }
    if (!selected) {
      return {
        text: `NekoSearch version: ${PACKAGE_VERSION}\nNo snapshot exists for ${input.selector}; run "nekosearch list" to see available selectors.\n`,
        exitCode: 1,
      };
    }
    entries = [selected];
    header = `Snapshot: readable (${input.selector})`;
  } else {
    const overview = await readCatalogOverview(options);
    entries = overview.entries;
    readable = overview.readable;
    errors = overview.errors;
    header = `Catalog: ${readable ? 'readable' : 'unreadable'}`;
  }

  let checks: UpstreamRevisionResult[] = [];
  if (input.checkUpstream && readable) {
    checks = await checkUpstreamRevisions(entries, options);
  }
  const checkBySelector = new Map(
    checks.map((check) => [check.selector, check]),
  );
  const rows = entries.map((entry) => {
    const selector = `${entry.source}@${entry.version}`;
    const tracking = getSnapshotTrackingState(entry);
    return [
      selector,
      entry.revision,
      snapshotOrigin(entry, tracking),
      tracking,
      formatUpstreamStatus(
        entry.status === 'bundled' ? undefined : checkBySelector.get(selector),
        input.checkUpstream,
        entry.status === 'bundled',
      ),
    ]
      .map(formatTableCell)
      .join('\t');
  });
  const output = [
    `NekoSearch version: ${PACKAGE_VERSION}`,
    header,
    ...(errors.length > 0 ? [`Catalog details: ${errors.join('; ')}`] : []),
    '',
    ['SELECTOR', 'ACTIVE_REVISION', 'ORIGIN', 'TRACKING', 'UPSTREAM'].join(
      '\t',
    ),
    ...rows,
    '',
  ].join('\n');
  const checkFailed = checks.some((check) => check.status === 'check failed');
  return {
    text: output,
    exitCode: !readable || checkFailed ? 1 : 0,
  };
}

function snapshotOrigin(
  entry: DocumentationCatalogEntry,
  tracking: ReturnType<typeof getSnapshotTrackingState>,
): string {
  if (entry.status === 'bundled') return 'bundled';
  if (tracking === 'tracked') return 'curated';
  return entry.manifest.source.kind === 'git'
    ? 'imported Git'
    : 'imported local';
}

function formatUpstreamStatus(
  result: UpstreamRevisionResult | undefined,
  enabled: boolean,
  bundled: boolean,
): string {
  if (!enabled) return 'not checked';
  if (bundled) return 'not applicable';
  if (!result) return 'not checked';
  if (result.status === 'current') {
    return `${result.status}: ${result.upstreamRevision ?? ''}`;
  }
  if (result.status === 'changed') {
    return `changed: tracked ref resolves to a different commit (${result.upstreamRevision ?? ''})`;
  }
  if (result.status === 'check failed') {
    return `check failed: ${result.error ?? 'upstream check failed'}`;
  }
  return 'untracked';
}

function formatTableCell(value: string): string {
  return value.replace(/[\t\r\n]+/gu, ' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
