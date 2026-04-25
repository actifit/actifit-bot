const moment = require('moment');
const _ = require('lodash');
const jwt = require('jsonwebtoken');

describe('Moment.js (Date handling)', () => {
  describe('Date creation', () => {
    test('should create current date', () => {
      const now = moment();
      expect(now.isValid()).toBe(true);
    });

    test('should create date from Date object', () => {
      const date = moment(new Date());
      expect(date.isValid()).toBe(true);
    });
  });

  describe('Date formatting', () => {
    test('should format date as YYYY-MM-DD', () => {
      const date = moment('2024-01-15').format('YYYY-MM-DD');
      expect(date).toBe('2024-01-15');
    });

    test('should get start of day in UTC', () => {
      const startOfDay = moment().utc().startOf('date').format('YYYY-MM-DD');
      expect(startOfDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('should subtract days from date', () => {
      const date = moment('2024-01-15').subtract(7, 'days').format('YYYY-MM-DD');
      expect(date).toBe('2024-01-08');
    });

    test('should add days to date', () => {
      const date = moment('2024-01-15').add(7, 'days').format('YYYY-MM-DD');
      expect(date).toBe('2024-01-22');
    });
  });

  describe('UTC handling (app.js pattern)', () => {
    test('should handle UTC date calculations like app.js', () => {
      const startDate = moment().utc().startOf('date').toDate();
      const sevenDaysAgo = moment(startDate).subtract(7, 'days').toDate();

      expect(sevenDaysAgo).toBeInstanceOf(Date);
      expect(sevenDaysAgo.getTime()).toBeLessThan(startDate.getTime());
    });
  });
});

describe('Lodash (Utility functions)', () => {
  describe('Array operations', () => {
    test('should chunk array', () => {
      const result = _.chunk([1, 2, 3, 4, 5], 2);
      expect(result).toEqual([[1, 2], [3, 4], [5]]);
    });

    test('should find unique values', () => {
      const result = _.uniq([1, 2, 2, 3, 3, 3]);
      expect(result).toEqual([1, 2, 3]);
    });

    test('should filter array', () => {
      const result = _.filter([1, 2, 3, 4], n => n > 2);
      expect(result).toEqual([3, 4]);
    });
  });

  describe('Object operations', () => {
    test('should merge objects', () => {
      const result = _.merge({ a: 1 }, { b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    test('should pick object properties', () => {
      const result = _.pick({ a: 1, b: 2, c: 3 }, ['a', 'b']);
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('String operations', () => {
    test('should capitalize string', () => {
      const result = _.capitalize('hello');
      expect(result).toBe('Hello');
    });

    test('should truncate string', () => {
      const result = _.truncate('hello world', { length: 8 });
      expect(result).toMatch(/^\w+\.\.\.$/);
    });
  });
});

describe('JSON Web Token (JWT)', () => {
  const secret = 'test-secret-key';

  describe('Token generation', () => {
    test('should sign a token', () => {
      const token = jwt.sign({ data: 'test' }, secret);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    test('should sign with expiration', () => {
      const token = jwt.sign({ data: 'test' }, secret, { expiresIn: '1h' });
      expect(token).toBeDefined();
    });
  });

  describe('Token verification', () => {
    test('should verify a valid token', () => {
      const token = jwt.sign({ userId: 1 }, secret);
      const decoded = jwt.verify(token, secret);
      expect(decoded.userId).toBe(1);
    });

    test('should fail on invalid token', () => {
      try {
        jwt.verify('invalid-token', secret);
      } catch (error) {
        expect(error).toBeDefined();
        expect(error.name).toBe('JsonWebTokenError');
      }
    });

    test('should fail on expired token', () => {
      const token = jwt.sign({ data: 'test' }, secret, { expiresIn: '-1s' });
      try {
        jwt.verify(token, secret);
      } catch (error) {
        expect(error).toBeDefined();
        expect(error.name).toBe('TokenExpiredError');
      }
    });
  });
});