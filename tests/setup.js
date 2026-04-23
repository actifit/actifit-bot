// Mock native Node.js modules that Jest can't resolve
jest.mock('node:fs', () => ({}));
jest.mock('node:crypto', () => require('crypto'));