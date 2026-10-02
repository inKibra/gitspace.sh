import { expect, test } from 'bun:test';
import { redactCredentials } from '../src/index.js';

test('redacts credential strings without corrupting nonstring payload fields', () => {
  expect(redactCredentials({
    password: false,
    apiKey: { configured: true },
    nested: { accessToken: 'do-not-publish' },
    message: 'request used dedicated-private-key',
    value: 'verified',
    key: 'ordinary-record-key',
  }, ['dedicated-private-key'])).toEqual({
    password: false,
    apiKey: { configured: true },
    nested: { accessToken: '[REDACTED]' },
    message: 'request used [REDACTED]',
    value: 'verified',
    key: 'ordinary-record-key',
  });
});
