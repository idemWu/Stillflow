import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/server/errors.js';
import { isPrivateAddress, validateFormatId, validateUrlSyntax } from '../src/server/security.js';

test('accepts a normal public HTTPS URL', () => {
  const result = validateUrlSyntax('https://www.youtube.com/watch?v=abc#section');
  assert.equal(result.hostname, 'www.youtube.com');
  assert.equal(result.hash, '');
});

test('rejects unsupported protocols and embedded credentials', () => {
  assert.throws(() => validateUrlSyntax('file:///etc/passwd'), AppError);
  assert.throws(() => validateUrlSyntax('https://user:pass@example.com/video'), AppError);
  assert.throws(() => validateUrlSyntax('ftp://example.com/video.mp4'), AppError);
});

test('rejects loopback, private, reserved, and local hostnames', () => {
  for (const value of [
    'https://127.0.0.1/video',
    'https://10.20.30.40/video',
    'https://192.168.1.1/video',
    'https://[::1]/video',
    'https://service.local/video',
  ]) {
    assert.throws(() => validateUrlSyntax(value), (error: unknown) => {
      return error instanceof AppError && error.code === 'PRIVATE_ADDRESS';
    });
  }
});

test('classifies special network ranges as private', () => {
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('198.51.100.7'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('rejects non-standard ports, control characters, and unsafe format ids', () => {
  assert.throws(() => validateUrlSyntax('https://youtube.com:8443/watch?v=abc'), AppError);
  assert.throws(() => validateUrlSyntax('https://youtube.com/\\evil'), AppError);
  assert.equal(validateFormatId('137'), '137');
  assert.throws(() => validateFormatId('137/best; rm'), AppError);
});
