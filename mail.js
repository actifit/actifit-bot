'use strict';
const nodemailer = require('nodemailer');
var utils = require('./utils');

const config = utils.getConfig();

// Reusable SMTP transport.
//
// Host/port/TLS are configurable, defaulting to the previous hardcoded SparkPost
// values so an existing deployment behaves identically. They used to be fixed, which
// quietly made this SparkPost-only: pointing smtp_usr/smtp_key at an ordinary mailbox
// (Google Workspace, a host's own server) authenticated against the wrong machine.
const smtpPort = Number(config.smtp_port) > 0 ? Number(config.smtp_port) : 587;
let transporter = nodemailer.createTransport({
    host: config.smtp_host || 'smtp.sparkpostmail.com',
    port: smtpPort,
    // 465 is implicit TLS, everything else STARTTLS. Getting that pair wrong is the
    // usual cause of a transport that connects and then hangs.
    secure: typeof config.smtp_secure === 'boolean' ? config.smtp_secure : smtpPort === 465,
    auth: {
        user: config.smtp_usr,
        pass: config.smtp_key
    }
});

// setup email data with unicode symbols
let mailOptions = {
    from: config.smtp_from, // sender address
};

function sendPlainMail(subject, message, to) {
	if(Array.isArray(to))
		to = to.join(',');
	// setup email data 
	mailOptions.subject = subject;
	mailOptions.text = message;
	mailOptions.to = to;

	// send mail with defined transport object
	return new Promise((resolve, reject) => {
	  transporter.sendMail(mailOptions, (error, info) => {
		    if (error) {
		        console.log(error);
		        return reject(error);
		    } else {
		    console.log('Message sent: %s', info.messageId);
		    // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>
		    resolve(info);
		    }
		});
	});
	
}

function sendWithTemplate(subject, data, to, template, attachment) {

	if(Array.isArray(to))
		to = to.join(',');
	
	//reference the plugin
	var hbs = require('nodemailer-express-handlebars');
	var exphbs  = require('express-handlebars');

	var engine =  exphbs();
	var options = 
	{
		viewEngine: engine,
		viewPath: 'views'
	}
	//attach the plugin to the nodemailer transporter
	transporter.use('compile', hbs(options));

	//send mail with options
	mailOptions.subject = subject;
	mailOptions.to = to;
	mailOptions.template = template;
	mailOptions.context = data;
	if (attachment) {
		mailOptions.attachments = [attachment]
	}

	// send mail with defined transport object
	return new Promise((resolve, reject) => {
	  transporter.sendMail(mailOptions, (error, info) => {
		    if (error) {
		        console.log(error);
		        return reject(error);
		    } else {
		    console.log('Message sent: %s', info.messageId);
		    // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>
		    resolve(info);
		    }
		});
	});
}

 module.exports = {
   sendPlainMail: sendPlainMail,
   sendWithTemplate: sendWithTemplate
 };

