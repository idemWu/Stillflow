import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFormatExpression } from '../src/server/downloadManager.js';
import { classifyEngineError } from '../src/server/errors.js';
import { normalizeFormats, normalizeMediaInfo } from '../src/server/media.js';
import { detectPlatform } from '../src/server/platform.js';

test('detects supported platform hosts without substring confusion', () => {
  assert.equal(detectPlatform('https://youtu.be/abc').id, 'youtube');
  assert.equal(detectPlatform('https://mobile.twitter.com/user/status/1').id, 'x');
  assert.equal(detectPlatform('https://youtube.com.evil.example/video').id, 'other');
});

test('normalizes one preferred safe format per height', () => {
  const formats = normalizeFormats([
    { format_id: '18', ext: 'mp4', protocol: 'https', height: 360, width: 640, vcodec: 'avc1', acodec: 'aac', tbr: 500 },
    { format_id: '43', ext: 'webm', protocol: 'https', height: 360, width: 640, vcodec: 'vp9', acodec: 'opus', tbr: 800 },
    { format_id: '137', ext: 'mp4', protocol: 'https', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', fps: 60 },
    { format_id: 'sb0', ext: 'mhtml', height: 90, width: 160, vcodec: 'images', acodec: 'none', format_note: 'storyboard' },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'aac' },
  ]);

  assert.deepEqual(formats.map((item) => item.id), ['137', '18']);
  assert.equal(formats[0].label, '1080p · 60 FPS');
  assert.equal(formats[1].hasAudio, true);
});

test('normalizes media metadata and keeps a supported source', () => {
  const media = normalizeMediaInfo({
    id: 'abc',
    title: 'Example video',
    uploader: 'Creator',
    duration: 65.2,
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    thumbnails: [
      { url: 'https://img.example/small.jpg', width: 320 },
      { url: 'https://img.example/large.jpg', width: 1280 },
    ],
    formats: [
      { format_id: '18', ext: 'mp4', protocol: 'https', height: 360, width: 640, vcodec: 'avc1', acodec: 'aac' },
    ],
  }, 'https://youtu.be/abc');

  assert.equal(media.platform.id, 'youtube');
  assert.equal(media.thumbnailUrl, 'https://img.example/large.jpg');
  assert.equal(media.author, 'Creator');
});

test('maps common upstream failures to stable client codes', () => {
  assert.equal(classifyEngineError('ERROR: Sign in to confirm your age').code, 'AUTH_REQUIRED');
  assert.equal(classifyEngineError('ERROR: HTTP Error 429: Too Many Requests').code, 'RATE_LIMITED');
  assert.equal(classifyEngineError('ERROR: Unsupported URL').code, 'UNSUPPORTED');
});

test('does not append a second audio track to an already muxed format', () => {
  assert.equal(buildFormatExpression('18', true), '18');
  assert.equal(buildFormatExpression('137', false), '137+ba[ext=m4a]/137+ba/137');
});
