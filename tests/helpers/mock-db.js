/**
 * Shared mock MongoDB for integration-style tests.
 *
 * Provides a mutable mock database object that tests can seed
 * before making HTTP requests. The mock is injected via jest.doMock
 * before requiring app.js.
 */

const { ObjectId } = require('mongodb');

/**
 * Create a mock collection with CRUD methods backed by an in-memory array.
 */
function createMockCollection(initialData = []) {
  let data = [...initialData];

  return {
    findOne: jest.fn((query) => {
      const result = data.find((doc) => matchQuery(doc, query));
      return Promise.resolve(result || null);
    }),
    find: jest.fn((query = {}) => {
      const results = data.filter((doc) => matchQuery(doc, query));
      return createCursor(results);
    }),
    insertOne: jest.fn((doc) => {
      data.push(doc);
      return Promise.resolve({ insertedId: doc._id || new ObjectId() });
    }),
    insertMany: jest.fn((docs) => {
      data.push(...docs);
      return Promise.resolve({ insertedCount: docs.length });
    }),
    updateOne: jest.fn((query, update) => {
      const idx = data.findIndex((doc) => matchQuery(doc, query));
      if (idx !== -1) {
        if (update.$set) Object.assign(data[idx], update.$set);
        else Object.assign(data[idx], update);
      }
      return Promise.resolve({ modifiedCount: idx !== -1 ? 1 : 0 });
    }),
    updateMany: jest.fn((query, update) => {
      let count = 0;
      data.forEach((doc, idx) => {
        if (matchQuery(doc, query)) {
          if (update.$set) Object.assign(data[idx], update.$set);
          else Object.assign(data[idx], update);
          count++;
        }
      });
      return Promise.resolve({ modifiedCount: count });
    }),
    replaceOne: jest.fn((query, replacement, opts = {}) => {
      const idx = data.findIndex((doc) => matchQuery(doc, query));
      if (idx !== -1) {
        data[idx] = replacement;
      } else if (opts.upsert) {
        data.push(replacement);
      }
      return Promise.resolve({ modifiedCount: idx !== -1 ? 1 : 0, upsertedCount: opts.upsert && idx === -1 ? 1 : 0 });
    }),
    deleteMany: jest.fn((query) => {
      const before = data.length;
      data = data.filter((doc) => !matchQuery(doc, query));
      return Promise.resolve({ deletedCount: before - data.length });
    }),
    aggregate: jest.fn((pipeline) => {
      // Simplified: just return all data for now
      return createCursor(data);
    }),
    distinct: jest.fn(() => Promise.resolve([])),
    // Expose data for test assertions
    __data: () => data,
    __clear: () => { data = []; },
    __seed: (docs) => { data.push(...docs); },
  };
}

/**
 * Create a mock cursor with chainable methods.
 */
function createCursor(results) {
  return {
    toArray: jest.fn(() => Promise.resolve([...results])),
    sort: jest.fn(() => createCursor(results)),
    limit: jest.fn((n) => createCursor(results.slice(0, n))),
    skip: jest.fn((n) => createCursor(results.slice(n))),
    count: jest.fn(() => Promise.resolve(results.length)),
  };
}

/**
 * Simple query matcher supporting exact equality and $ operators.
 */
function matchQuery(doc, query) {
  if (!query || typeof query !== 'object') return true;
  for (const key of Object.keys(query)) {
    if (key === '_id' && query[key] instanceof ObjectId) {
      if (doc._id?.toString() !== query[key].toString()) return false;
      continue;
    }
    if (typeof query[key] === 'object' && query[key] !== null) {
      // Handle $ operators
      if (query[key].$gte !== undefined && !(doc[key] >= query[key].$gte)) return false;
      if (query[key].$lte !== undefined && !(doc[key] <= query[key].$lte)) return false;
      if (query[key].$gt !== undefined && !(doc[key] > query[key].$gt)) return false;
      if (query[key].$lt !== undefined && !(doc[key] < query[key].$lt)) return false;
      if (query[key].$ne !== undefined && doc[key] === query[key].$ne) return false;
      if (query[key].$in !== undefined && !query[key].$in.includes(doc[key])) return false;
      if (query[key].$nin !== undefined && query[key].$nin.includes(doc[key])) return false;
      if (query[key].$exists !== undefined) {
        const hasKey = doc[key] !== undefined;
        if (query[key].$exists && !hasKey) return false;
        if (!query[key].$exists && hasKey) return false;
      }
    } else {
      if (doc[key] !== query[key]) return false;
    }
  }
  return true;
}

/**
 * Create a full mock DB with named collections.
 */
function createMockDb(collections = {}) {
  const cols = {};

  return {
    collection: jest.fn((name) => {
      if (!cols[name]) {
        cols[name] = createMockCollection(collections[name] || []);
      }
      return cols[name];
    }),
    __collections: () => cols,
    __clearAll: () => {
      Object.values(cols).forEach((col) => col.__clear());
    },
  };
}

module.exports = {
  createMockCollection,
  createMockDb,
  createCursor,
};
