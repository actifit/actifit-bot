module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['./tests/setup.js'],
  collectCoverageFrom: [
    '*.js',
    '!**/*.test.js',
    '!node_modules/**',
    '!heroku-setup.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  testTimeout: 10000,
  verbose: true,
  resolver: undefined
};