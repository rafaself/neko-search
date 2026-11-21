import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { CURATED_REMOTE_SNAPSHOT_RECIPES } from '../remote-snapshots.js';

const curatedSelector = z.enum(
  CURATED_REMOTE_SNAPSHOT_RECIPES.map(({ selector }) => selector),
);
const selector = z
  .string()
  .trim()
  .max(321)
  .regex(/^.+@[^@]+$/u);
const snapshotKey = z.string().regex(/^[a-f0-9]{64}$/u);

export const dashboardJobRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('import-directory'),
    selector,
    directory: z
      .string()
      .refine((path) => isAbsolute(path) && !path.includes('\0')),
  }),
  z.strictObject({
    operation: z.literal('install-curated'),
    selector: curatedSelector,
  }),
  z.strictObject({
    operation: z.literal('check-upstream'),
    selector: curatedSelector,
  }),
  z.strictObject({
    operation: z.literal('update'),
    selector: curatedSelector,
    snapshotKey,
  }),
  z.strictObject({ operation: z.literal('remove'), selector, snapshotKey }),
]);

export type DashboardJobRequest = z.infer<typeof dashboardJobRequestSchema>;

export interface DashboardJobResult {
  message: string;
  catalogChanged: boolean;
  warning?: string;
}

export type DashboardJobStatus =
  | { state: 'running'; phase: string }
  | { state: 'succeeded'; result: DashboardJobResult }
  | { state: 'failed'; error: string };

export interface DashboardJob {
  id: string;
  status: DashboardJobStatus;
}
