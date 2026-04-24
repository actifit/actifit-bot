/**
 * Unit tests for mail.js functions
 */

const path = require('path');

jest.doMock('node:fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, 'test-config.json'), options);
      }
      return actual.readFileSync(filePath, options);
    }),
  };
});

jest.doMock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, 'test-config.json'), options);
      }
      return actual.readFileSync(filePath, options);
    }),
  };
});

jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
}));

const mockSendMail = jest.fn((options, callback) => {
  callback(null, { messageId: 'test-message-id-123' });
});

jest.doMock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
    use: jest.fn(),
  })),
}));

describe('Mail.js Unit Tests', () => {
  let mail;

  beforeEach(() => {
    jest.clearAllMocks();
    mail = require('../mail');
  });

  describe('sendPlainMail', () => {
    test('sends mail with correct options for single recipient', async () => {
      const result = await mail.sendPlainMail('Test Subject', 'Test message body', 'user@example.com');

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const sentOptions = mockSendMail.mock.calls[0][0];
      expect(sentOptions.subject).toBe('Test Subject');
      expect(sentOptions.text).toBe('Test message body');
      expect(sentOptions.to).toBe('user@example.com');
      expect(result.messageId).toBe('test-message-id-123');
    });

    test('joins array recipients into comma-separated string', async () => {
      await mail.sendPlainMail('Subject', 'Body', ['a@example.com', 'b@example.com']);

      const sentOptions = mockSendMail.mock.calls[0][0];
      expect(sentOptions.to).toBe('a@example.com,b@example.com');
    });

    test('rejects when transporter returns error', async () => {
      mockSendMail.mockImplementationOnce((options, callback) => {
        callback(new Error('SMTP failure'), null);
      });

      await expect(mail.sendPlainMail('Subj', 'Body', 'user@example.com')).rejects.toThrow('SMTP failure');
    });
  });

  describe('sendWithTemplate', () => {
    test('sends templated mail with correct options', async () => {
      const templateData = { name: 'TestUser', score: 100 };
      const result = await mail.sendWithTemplate('Welcome', templateData, 'user@example.com', 'welcome-template');

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const sentOptions = mockSendMail.mock.calls[0][0];
      expect(sentOptions.subject).toBe('Welcome');
      expect(sentOptions.to).toBe('user@example.com');
      expect(sentOptions.template).toBe('welcome-template');
      expect(sentOptions.context).toEqual(templateData);
      expect(result.messageId).toBe('test-message-id-123');
    });

    test('includes attachment when provided', async () => {
      const attachment = { filename: 'report.pdf', content: Buffer.from('pdf-data') };
      await mail.sendWithTemplate('Report', {}, 'user@example.com', 'report-template', attachment);

      const sentOptions = mockSendMail.mock.calls[0][0];
      expect(sentOptions.attachments).toEqual([attachment]);
    });

    test('joins array recipients into comma-separated string', async () => {
      await mail.sendWithTemplate('Subj', {}, ['a@example.com', 'b@example.com'], 'tmpl');

      const sentOptions = mockSendMail.mock.calls[0][0];
      expect(sentOptions.to).toBe('a@example.com,b@example.com');
    });
  });
});
