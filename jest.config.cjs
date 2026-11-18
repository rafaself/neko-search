/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/build.cjs',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@nestjs-docs/documentation-engine/(.*)\\.js$':
      '<rootDir>/packages/documentation-engine/src/modules/documentation/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  collectCoverageFrom: [
    'apps/nekosearch/src/**/*.ts',
    'packages/documentation-engine/src/**/*.ts',
  ],
  coverageDirectory: 'coverage',
};
