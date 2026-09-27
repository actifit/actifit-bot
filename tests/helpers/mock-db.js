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
    updateOne: jest.fn((query, update, opts = {}) => {
      const applyInc = (doc) => { for (const k of Object.keys(update.$inc)) doc[k] = (Number(doc[k]) || 0) + update.$inc[k]; };
      const idx = data.findIndex((doc) => matchQuery(doc, query));
      if (idx !== -1) {
        if (update.$set) Object.assign(data[idx], update.$set);
        if (update.$inc) applyInc(data[idx]);
        if (!update.$set && !update.$inc) Object.assign(data[idx], update);
        return Promise.resolve({ modifiedCount: 1, upsertedCount: 0 });
      }
      if (opts.upsert) {
        const doc = {};
        for (const k of Object.keys(query)) { if (typeof query[k] !== 'object' || query[k] === null) doc[k] = query[k]; }
        if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$inc) applyInc(doc);
        data.push(doc);
        return Promise.resolve({ modifiedCount: 0, upsertedCount: 1 });
      }
      return Promise.resolve({ modifiedCount: 0, upsertedCount: 0 });
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
    deleteOne: jest.fn((query) => {
      const idx = data.findIndex((doc) => matchQuery(doc, query));
      if (idx !== -1) {
        data.splice(idx, 1);
        return Promise.resolve({ deletedCount: 1 });
      }
      return Promise.resolve({ deletedCount: 0 });
    }),
    deleteMany: jest.fn((query) => {
      const before = data.length;
      data = data.filter((doc) => !matchQuery(doc, query));
      return Promise.resolve({ deletedCount: before - data.length });
    }),
    aggregate: jest.fn((pipeline) => {
      // Minimal but REAL $match/$group support. This used to ignore the pipeline
      // and return every document, which silently made any aggregation look like a
      // full collection read - so code that replaced a scan with a server-side sum
      // could not be tested, and a test could pass while the real query did
      // something completely different. Only the stages the arena code actually
      // uses are implemented; anything else throws loudly rather than quietly
      // returning the wrong thing.
      if (!Array.isArray(pipeline)) return createCursor(data);
      let docs = data.slice();
      for (const stage of pipeline) {
        const op = Object.keys(stage)[0];
        if (op === '$match') {
          docs = docs.filter((d) => matchQuery(d, stage.$match));
        } else if (op === '$group') {
          const spec = stage.$group;
          const groups = new Map();
          for (const d of docs) {
            // only a literal null _id (grand total) is supported
            const key = spec._id === null ? '__all__' : String(resolveField(d, spec._id));
            if (!groups.has(key)) groups.set(key, { _id: spec._id === null ? null : resolveField(d, spec._id) });
            const g = groups.get(key);
            for (const [field, acc] of Object.entries(spec)) {
              if (field === '_id') continue;
              if (acc && acc.$sum !== undefined) {
                const add = typeof acc.$sum === 'number' ? acc.$sum : (Number(resolveField(d, acc.$sum)) || 0);
                g[field] = (g[field] || 0) + add;
              } else if (acc && acc.$max !== undefined) {
                const v = resolveField(d, acc.$max);
                g[field] = g[field] === undefined ? v : (v > g[field] ? v : g[field]);
              } else {
                throw new Error('mock-db aggregate: unsupported accumulator ' + JSON.stringify(acc));
              }
            }
          }
          docs = [...groups.values()];
        } else if (op === '$limit') {
          docs = docs.slice(0, stage.$limit);
        } else {
          throw new Error('mock-db aggregate: unsupported stage ' + op);
        }
      }
      return createCursor(docs);
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
 * Resolve an aggregation field reference ("$token_count") or a literal.
 */
function resolveField(doc, ref) {
  if (typeof ref === 'string' && ref.startsWith('$')) return doc[ref.slice(1)];
  return ref;
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
