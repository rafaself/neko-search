import { createRequire, findPackageJSON } from 'node:module';
import { dirname } from 'node:path';
import * as z from 'zod';

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: 'must not be blank',
  });

export const packageMetadataSchema = z.looseObject({
  name: nonBlankStringSchema,
  version: nonBlankStringSchema,
  description: nonBlankStringSchema,
});

const manifestPath = findPackageJSON('./', import.meta.url);
if (!manifestPath) throw new Error('NekoSearch package manifest is missing');

export const PACKAGE_DIRECTORY = dirname(manifestPath);
const packageMetadata = packageMetadataSchema.parse(
  createRequire(import.meta.url)(manifestPath),
);

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const PACKAGE_DESCRIPTION = packageMetadata.description;
