/**
 * Tests for the daily AFIT -> Hive-Engine move cleanup / notification changes
 * and the mongodb driver 5.x migration in delegations.js.
 *
 * These exercise the real exported functions against an in-memory mock DB
 * (injected via __setTestDb). sendNotification is spied so no Firebase / real
 * notification writes happen.
 *
 * Note: the expiry-guard and insufficient-funds branches live inside
 * moveAFITToSE(), which opens its own Mongo connection, so they can't be driven
 * with the mock DB here - but both delegate to cancelDailyAFITPowerDown(), which
 * is covered directly below. Drive moveAFITToSE() itself against a scratch DB in
 * staging.
 */

const { ObjectId } = require('mongodb');
const { createMockDb } = require('./helpers/mock-db');
const utils = require('../utils');
const delegations = require('../delegations');

describe('delegations - daily AFIT move cleanup & notifications', () => {
  let db;
  let notifySpy;

  const daysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  };

  beforeEach(() => {
    db = createMockDb();
    delegations.__setTestDb(db);
    notifySpy = jest.spyOn(utils, 'sendNotification').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('deactivateDailyAFITPowerDown (7-day cleanup, now using deleteOne)', () => {
    test('deletes an entry older than the powerdown window', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'alice', daily_afit_transfer: 100, date: daysAgo(30) };
      db.collection('powering_down_he').__seed([entry]);

      await delegations.deactivateDailyAFITPowerDown(entry, false);

      expect(db.collection('powering_down_he').deleteOne).toHaveBeenCalledWith({ _id: id });
      expect(db.collection('powering_down_he').__data()).toHaveLength(0);
    });

    test('keeps an entry that is still within the window', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'bob', daily_afit_transfer: 100, date: new Date() };
      db.collection('powering_down_he').__seed([entry]);

      await delegations.deactivateDailyAFITPowerDown(entry, false);

      expect(db.collection('powering_down_he').deleteOne).not.toHaveBeenCalled();
      expect(db.collection('powering_down_he').__data()).toHaveLength(1);
    });

    test('does not delete in testMode even when stale', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'carol', daily_afit_transfer: 100, date: daysAgo(30) };
      db.collection('powering_down_he').__seed([entry]);

      await delegations.deactivateDailyAFITPowerDown(entry, true);

      expect(db.collection('powering_down_he').__data()).toHaveLength(1);
    });
  });

  describe('cancelDailyAFITPowerDown (immediate cancel + notify)', () => {
    test('deletes the entry and notifies the user when a message is given', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'dave', daily_afit_transfer: 100, date: new Date() };
      db.collection('powering_down_he').__seed([entry]);
      const msg = 'Your daily move of 100 AFIT to Hive-Engine was cancelled: insufficient funds.';

      await delegations.cancelDailyAFITPowerDown(entry, false, msg);

      expect(db.collection('powering_down_he').__data()).toHaveLength(0);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledWith(
        db, 'dave', 'actifit', 'afit_move_cancelled', 'afit_move_cancelled', msg, 'https://actifit.io/@dave'
      );
    });

    test('deletes silently (no notification) when message is null - expiry path', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'erin', daily_afit_transfer: 100, date: daysAgo(30) };
      db.collection('powering_down_he').__seed([entry]);

      await delegations.cancelDailyAFITPowerDown(entry, false, null);

      expect(db.collection('powering_down_he').__data()).toHaveLength(0);
      expect(notifySpy).not.toHaveBeenCalled();
    });

    test('does nothing in testMode (no delete, no notify)', async () => {
      const id = new ObjectId();
      const entry = { _id: id, user: 'frank', daily_afit_transfer: 100, date: new Date() };
      db.collection('powering_down_he').__seed([entry]);

      await delegations.cancelDailyAFITPowerDown(entry, true, 'msg');

      expect(db.collection('powering_down_he').__data()).toHaveLength(1);
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  describe('mongodb driver 5.x migration regressions', () => {
    test('updateUserCount decrements the off-chain balance via replaceOne', async () => {
      db.collection('user_tokens').__seed([{ _id: 'grace', user: 'grace', tokens: 500 }]);

      await delegations.updateUserCount({ user: 'grace', daily_afit_transfer: 100 });

      const doc = db.collection('user_tokens').__data()[0];
      expect(doc.tokens).toBe(400);
      expect(db.collection('user_tokens').replaceOne).toHaveBeenCalled();
    });

    test('rollBackTrans removes the inserted token_transaction via deleteOne', async () => {
      const id = new ObjectId();
      const moveTrans = { _id: id, user: 'heidi', token_count: -100 };
      db.collection('token_transactions').__seed([moveTrans]);

      await delegations.rollBackTrans(moveTrans);

      expect(db.collection('token_transactions').deleteOne).toHaveBeenCalledWith({ _id: id });
      expect(db.collection('token_transactions').__data()).toHaveLength(0);
    });
  });
});
