#!/usr/bin/env node
'use strict';

/**
 * Send a REAL Arena alert to config.report_emails, through the exact same path the
 * settlement alarm uses.
 *
 * Why this exists: the alarm only fires when settlement actually stalls, so the first
 * time anyone discovers the mail route is broken is during the incident it was built
 * for. `report_emails` being set does not mean a message can leave the box - the SMTP
 * host, credentials and the From address all have to be right, and a wrong one usually
 * fails silently or hangs rather than erroring loudly.
 *
 * Run it on the SECOND_API box, from the app directory (config.json is read relative
 * to the working directory):
 *
 *   cd /home/actifit-bot && node scripts/arena_alert_test.js
 *
 * It sends one email and writes nothing. It does not touch arena_health, the ledger,
 * the chain, or any challenge.
 */

const path = require('path');
const utils = require('../utils');

(async () => {
	const config = utils.getConfig();
	const to = config.report_emails;

	console.log('config.json   : ' + path.resolve('config.json'));
	console.log('smtp_host     : ' + (config.smtp_host || 'smtp.sparkpostmail.com (default)'));
	console.log('smtp_port     : ' + (config.smtp_port || 587));
	console.log('smtp_usr      : ' + (config.smtp_usr ? 'set' : '*** EMPTY ***'));
	console.log('smtp_key      : ' + (config.smtp_key ? 'set' : '*** EMPTY ***'));
	console.log('smtp_from     : ' + (config.smtp_from || '*** EMPTY ***'));
	console.log('report_emails : ' + (to || '*** EMPTY ***'));
	console.log('');

	const missing = [];
	if (!config.smtp_usr) missing.push('smtp_usr');
	if (!config.smtp_key) missing.push('smtp_key');
	if (!config.smtp_from) missing.push('smtp_from');
	if (!to || !to.length) missing.push('report_emails');
	if (missing.length) {
		console.error('FAIL: these are empty in config.json: ' + missing.join(', '));
		console.error('      The settlement alarm cannot page anyone until they are set.');
		process.exit(1);
	}

	// Required lazily and AFTER the checks above: mail.js builds its transport at
	// module scope, so requiring it first would obscure a plain missing-config case.
	const mail = require('../mail');

	const subject = 'Actifit Arena: alert delivery test (no incident)';
	const body = 'This is a TEST of the Arena settlement alarm. Nothing is wrong.\n\n'
		+ 'If you are reading this, a real alert can reach you. The alarm mails this same\n'
		+ 'address when settlement stalls - the treasury budget running dry, a challenge\n'
		+ 'failing every sweep, no posting key so nothing reaches the chain, or the sweep\n'
		+ 'not running at all.\n\n'
		+ 'Sent from : ' + path.resolve('config.json') + '\n'
		+ 'At        : ' + new Date().toISOString() + '\n';

	console.log('sending to ' + to + ' ...');
	try {
		const info = await mail.sendPlainMail(subject, body, to);
		console.log('OK: accepted by the SMTP server' + (info && info.messageId ? ' (' + info.messageId + ')' : ''));
		if (info && info.rejected && info.rejected.length) {
			console.error('WARNING: rejected recipients: ' + info.rejected.join(', '));
			process.exit(1);
		}
		console.log('');
		console.log('Accepted is not the same as delivered - check the inbox, and the spam folder.');
		console.log('If it never arrives, the usual cause is smtp_from not being an address the');
		console.log('SMTP provider has authorised this account to send as.');
		process.exit(0);
	} catch (e) {
		console.error('FAIL: ' + (e && e.message));
		if (e && e.code) console.error('      code: ' + e.code);
		console.error('');
		console.error('Common causes:');
		console.error('  EAUTH / 535        - smtp_usr or smtp_key wrong for this host');
		console.error('  ETIMEDOUT / ECONN  - smtp_host or smtp_port wrong, or the port is blocked');
		console.error('  ESOCKET            - TLS mismatch; port 465 needs smtp_secure: true');
		console.error('  550 / 553          - smtp_from is not an address this account may send as');
		process.exit(1);
	}
})();
