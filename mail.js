'use strict';
const nodemailer = require('nodemailer');
var utils = require('./utils');

const config = utils.getConfig();

// create reusable transporter object using the default SMTP transport
let transporter = nodemailer.createTransport({
	service: 'sparkpostmail',
    host: 'smtp.sparkpostmail.com',
    port: 587,
    secure: false, // true for 465, false for other ports
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

function sendWithTemplate(subject, data, to, template) {

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

