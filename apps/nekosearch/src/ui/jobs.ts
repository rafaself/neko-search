import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  DashboardJob,
  DashboardJobRequest,
  DashboardJobStatus,
} from './job-contract.js';

const MAX_RECENT_JOBS = 20;

export function createDashboardJobs() {
  const jobs = new Map<string, DashboardJob>();
  let running = false;

  return {
    get(id: string) {
      return jobs.get(id);
    },
    start(request: DashboardJobRequest) {
      if (running) return undefined;

      const job: DashboardJob = {
        id: randomUUID(),
        status: { state: 'running', phase: 'starting' },
      };
      jobs.set(job.id, job);
      if (jobs.size > MAX_RECENT_JOBS) {
        const oldest = jobs.keys().next().value;
        if (oldest) jobs.delete(oldest);
      }
      running = true;

      function report(status: DashboardJobStatus) {
        if (job.status.state !== 'running') return;
        job.status = status;
        if (status.state !== 'running') running = false;
      }

      try {
        const child = fork(new URL('./run-job.js', import.meta.url), {
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        child.on('message', (status) => report(status as DashboardJobStatus));
        child.once('error', (error) =>
          report({ state: 'failed', error: error.message }),
        );
        child.once('close', () =>
          report({
            state: 'failed',
            error:
              'The operation ended unexpectedly. Refresh the catalog before retrying.',
          }),
        );
        child.send(request, (error) => {
          if (error) report({ state: 'failed', error: error.message });
        });
      } catch (error) {
        report({
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return job;
    },
  };
}
