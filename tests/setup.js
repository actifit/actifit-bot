// Mock native Node.js modules that Jest can't resolve
jest.mock('node:fs', () => require('fs'));
jest.mock('node:fs/promises', () => require('fs').promises || {});
jest.mock('node:crypto', () => require('crypto'));
jest.mock('node:events', () => require('events'));
jest.mock('node:os', () => require('os'));
jest.mock('node:path', () => require('path'));
jest.mock('node:stream', () => require('stream'));
jest.mock('node:string_decoder', () => require('string_decoder'));
jest.mock('node:util', () => require('util'));
jest.mock('node:url', () => require('url'));