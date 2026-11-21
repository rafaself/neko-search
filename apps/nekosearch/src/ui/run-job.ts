import { getCatalogIndex, removeSnapshot } from '../catalog.js';
import { installLocalSnapshot } from '../local-snapshots.js';
import {
  checkUpstreamRevisions,
  CURATED_REMOTE_SNAPSHOT_RECIPES,
  getSnapshotTrackingState,
  installRemoteSnapshot,
} from '../remote-snapshots.js';
import {
  dashboardJobRequestSchema,
  type DashboardJobRequest,
  type DashboardJobResult,
  type DashboardJobStatus,
} from './job-contract.js';

process.once('message', (input: unknown) => {
  void finishJob(input);
});

async function finishJob(input: unknown) {
  let status: DashboardJobStatus;
  try {
    const result = await runJob(dashboardJobRequestSchema.parse(input));
    status = { state: 'succeeded', result };
  } catch (error) {
    status = {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (process.connected) {
    process.send?.(status, (error) => {
      if (error) process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    });
  }
}

async function runJob(
  request: DashboardJobRequest,
): Promise<DashboardJobResult> {
  const { selector } = request;
  switch (request.operation) {
    case 'import-directory': {
      reportProgress('indexing');
      await installLocalSnapshot(request.directory, selector);
      return { message: `Installed ${selector}.`, catalogChanged: true };
    }
    case 'remove': {
      reportProgress('removing');
      const { cleanupWarning } = await removeSnapshot(selector, {
        expectedSnapshotKey: request.snapshotKey,
      });
      return {
        message: `Removed ${selector}.`,
        catalogChanged: true,
        warning: cleanupWarning,
      };
    }
    case 'check-upstream': {
      reportProgress('checking');
      const entry = await getCatalogIndex(selector);
      if (!entry || getSnapshotTrackingState(entry) !== 'tracked') {
        throw new Error(`No tracked snapshot is installed for ${selector}.`);
      }
      const [check] = await checkUpstreamRevisions([entry]);
      if (check?.status !== 'current' && check?.status !== 'changed') {
        throw new Error(check?.error ?? `Could not check ${selector}.`);
      }
      return {
        message:
          check.status === 'current'
            ? `${selector} is current.`
            : `${selector} has a different upstream revision (${check.upstreamRevision}).`,
        catalogChanged: false,
      };
    }
    case 'install-curated':
    case 'update': {
      const recipe = CURATED_REMOTE_SNAPSHOT_RECIPES.find(
        (item) => item.selector === selector,
      );
      if (!recipe) throw new Error(`Unknown curated source ${selector}.`);
      const update = request.operation === 'update';
      const { changed } = await installRemoteSnapshot(
        recipe.source,
        recipe.version,
        update ? 'update' : 'add',
        {
          expectedSnapshotKey: update ? request.snapshotKey : undefined,
          onProgress: reportProgress,
        },
      );
      const message = changed
        ? `${update ? 'Updated' : 'Installed'} ${selector}.`
        : `${selector} is already current.`;
      return { message, catalogChanged: changed };
    }
  }
}

function reportProgress(phase: string) {
  if (process.connected)
    process.send?.({ state: 'running', phase } satisfies DashboardJobStatus);
}
