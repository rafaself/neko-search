import { createRequire } from 'node:module';
import { join } from 'node:path';

const modelDirectory = process.env.NEKOSEARCH_MODEL_DIR;
if (!modelDirectory) {
  throw new Error(
    'Set NEKOSEARCH_MODEL_DIR to an installed, verified Qwen3 model directory.',
  );
}

globalThis.fetch = async () => {
  throw new Error('Network access is disabled during local model validation.');
};

const runtimeRequire = createRequire(
  join(process.cwd(), 'nekosearch-runtime-loader.cjs'),
);
const transformers = runtimeRequire('@huggingface/transformers');
transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
const tokenizer = await transformers.AutoTokenizer.from_pretrained(
  modelDirectory,
  { local_files_only: true },
);
if (tokenizer.padding_side !== 'left') {
  throw new Error(`Expected left padding, got ${tokenizer.padding_side}`);
}
const padded = tokenizer(
  ['short', 'This longer document has several tokens to trigger left padding.'],
  { padding: true, truncation: true, max_length: 8192 },
);
assertLeftPadding(padded.attention_mask);

const generatorModule = await import(
  new URL(
    '../../dist/apps/nekosearch/local-qwen3-embedding-generator.js',
    import.meta.url,
  )
);
const generator = generatorModule.createLocalQwen3EmbeddingGenerator({
  modelDirectory,
});

const examples = [
  {
    query: 'What is the capital of China?',
    documents: [
      'The capital of China is Beijing.',
      'Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun.',
    ],
    expectedDocument: 0,
  },
  {
    query: 'Explain gravity',
    documents: [
      'The capital of China is Beijing.',
      'Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun.',
    ],
    expectedDocument: 1,
  },
];

for (const { query, documents, expectedDocument } of examples) {
  const queryVector = await generator.embedQuery(query);
  const documentVectors = await generator.embedDocuments(documents);
  assertVector(queryVector, `query: ${query}`);
  documentVectors.forEach((vector, index) =>
    assertVector(vector, `document ${index + 1}: ${documents[index]}`),
  );

  const scores = documentVectors.map((vector) => dot(queryVector, vector));
  const bestIndex = scores.indexOf(Math.max(...scores));
  if (bestIndex !== expectedDocument) {
    throw new Error(
      `Unexpected retrieval ranking for "${query}": expected document ${expectedDocument + 1}, got ${bestIndex + 1} (${scores.map((score) => score.toFixed(4)).join(', ')})`,
    );
  }
  process.stdout.write(
    `${query}\n  cosine similarities: ${scores.map((score) => score.toFixed(4)).join(', ')}\n`,
  );
}

process.stdout.write(
  `Validated local Qwen3 tokenizer and inference at ${modelDirectory} without network access.\n`,
);

function assertLeftPadding(mask) {
  const [batchSize, sequenceLength] = mask.dims;
  if (
    batchSize !== 2 ||
    !sequenceLength ||
    mask.data.length !== batchSize * sequenceLength
  ) {
    throw new Error('Tokenizer returned an unexpected attention mask shape');
  }
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    const row = Array.from({ length: sequenceLength }, (_, index) =>
      Number(mask.data[batchIndex * sequenceLength + index]),
    );
    const firstActiveToken = row.indexOf(1);
    if (
      firstActiveToken < 0 ||
      row.at(-1) !== 1 ||
      row.slice(0, firstActiveToken).some((value) => value !== 0) ||
      row.slice(firstActiveToken).some((value) => value !== 1)
    ) {
      throw new Error(
        `Invalid left-padded attention mask for batch row ${batchIndex}`,
      );
    }
    if (batchIndex === 0 && firstActiveToken === 0) {
      throw new Error('Tokenizer did not left-pad the shorter text');
    }
  }
}

function assertVector(vector, name) {
  if (!(vector instanceof Float32Array) || vector.length !== 1024) {
    throw new Error(`${name} must be a Float32Array with 1024 dimensions`);
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} contains a non-finite value`);
    }
    squaredNorm += value * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 1e-4) {
    throw new Error(`${name} is not L2 normalized`);
  }
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}
