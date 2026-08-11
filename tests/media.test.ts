import assert from 'node:assert/strict';
import test from 'node:test';
import type { ICreateDownloadResponse, IMediaFormat, IProbeResponse } from '../src/shared/types.js';
import { ApiClientError } from '../src/client/api.js';
import { createDownloadWithProbeRecovery } from '../src/client/downloadRecovery.js';
import { extractVideoUrlFromText } from '../src/shared/linkInput.js';
import { findEquivalentMediaFormat } from '../src/shared/mediaSelection.js';
import { buildFormatExpression, buildSingleMediaArguments } from '../src/server/downloadManager.js';
import { AppError, classifyEngineError } from '../src/server/errors.js';
import { fetchTrustedKuaishouMedia, probeKuaishou } from '../src/server/kuaishou.js';
import { normalizeFormats, normalizeMediaInfo } from '../src/server/media.js';
import { detectPlatform } from '../src/server/platform.js';
import { validateUrlSyntax } from '../src/server/security.js';

test('detects supported platform hosts without substring confusion', () => {
  assert.equal(detectPlatform('https://youtu.be/abc').id, 'youtube');
  assert.equal(detectPlatform('https://mobile.twitter.com/user/status/1').id, 'x');
  assert.equal(detectPlatform('https://v.douyin.com/AbC123/').id, 'douyin');
  assert.equal(detectPlatform('https://v.kuaishou.com/AbC123').id, 'kuaishou');
  assert.equal(detectPlatform('https://kuaishou.cn/short-video/3x123456').id, 'kuaishou');
  assert.equal(detectPlatform('https://youtube.com.evil.example/video').id, 'other');
  assert.equal(detectPlatform('https://kuaishou.com.evil.example/video').id, 'other');
});

test('extracts links from Douyin and Kuaishou mobile share copy', () => {
  assert.equal(
    extractVideoUrlFromText('2.31 复制打开抖音，看看【示例】 https://v.douyin.com/AbC123/ 05/12'),
    'https://v.douyin.com/AbC123/',
  );
  assert.equal(
    extractVideoUrlFromText('这个作品真有趣 https://v.kuaishou.com/JT195ZHT。复制此消息打开快手'),
    'https://v.kuaishou.com/JT195ZHT',
  );
  assert.equal(extractVideoUrlFromText('javascript:alert(1)'), null);
  assert.equal(extractVideoUrlFromText('这里只有文案，没有链接'), null);
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

test('keeps the requested platform identity after an upstream redirect', () => {
  const media = normalizeMediaInfo({
    id: '123',
    title: 'Douyin example',
    webpage_url: 'https://www.tiktok.com/@example/video/123',
    formats: [
      { format_id: 'source', ext: 'mp4', protocol: 'https', height: 720, width: 1280, vcodec: 'h264', acodec: 'aac' },
    ],
  }, 'https://www.douyin.com/video/123');

  assert.equal(media.platform.id, 'douyin');
});

test('maps common upstream failures to stable client codes', () => {
  assert.equal(classifyEngineError('ERROR: Sign in to confirm your age').code, 'AUTH_REQUIRED');
  assert.equal(classifyEngineError('ERROR: Fresh cookies (not necessarily logged in) are needed').code, 'AUTH_REQUIRED');
  assert.equal(classifyEngineError('ERROR: HTTP Error 429: Too Many Requests').code, 'RATE_LIMITED');
  assert.equal(classifyEngineError('ERROR: Unsupported URL').code, 'UNSUPPORTED');
});

test('does not append a second audio track to an already muxed format', () => {
  assert.equal(buildFormatExpression('18', true), '18');
  assert.equal(buildFormatExpression('137', false), '137+ba[ext=m4a]/137+ba/137');
});

test('limits downloads to one media item without yt-dlp max-downloads exit code', () => {
  const args = buildSingleMediaArguments();
  assert.ok(args.includes('--no-playlist'));
  assert.ok(!args.includes('--max-downloads'));
});

test('matches the same quality after an expired probe is refreshed', () => {
  const previous: IMediaFormat = {
    id: 'old-option', label: '576p', resolution: '1024 x 576', width: 1024, height: 576,
    fps: 30, extension: 'MP4', codec: 'h264', hasAudio: true, hdr: false, estimatedBytes: null,
  };
  const candidates = [
    { ...previous, id: 'new-360p', label: '360p', resolution: '640 x 360', width: 640, height: 360 },
    { ...previous, id: 'new-576p' },
  ];

  assert.equal(findEquivalentMediaFormat(previous, candidates)?.id, 'new-576p');
  assert.equal(findEquivalentMediaFormat(previous, [candidates[0]]), undefined);
});

function probeFixture(probeId: string, optionId: string): IProbeResponse {
  return {
    probeId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    media: {
      id: 'media-1',
      title: 'Public video',
      description: null,
      author: 'Creator',
      durationSeconds: 15,
      thumbnailUrl: null,
      publishedAt: null,
      viewCount: null,
      platform: { id: 'x', label: 'X / Twitter', host: 'x.com' },
      originalUrl: 'https://x.com/example/status/1',
      formats: [{
        id: optionId,
        label: '576p',
        resolution: '1024 x 576',
        width: 1024,
        height: 576,
        fps: 30,
        extension: 'MP4',
        codec: 'h264',
        hasAudio: true,
        hdr: false,
        estimatedBytes: null,
      }],
    },
  };
}

const readyDownloadFixture = { job: { id: 'job-1', status: 'queued' } } as ICreateDownloadResponse;

test('refreshes an expired probe once and retries the equivalent quality', async () => {
  const original = probeFixture('expired-probe', 'old-option');
  const refreshed = probeFixture('fresh-probe', 'new-option');
  const downloadCalls: Array<[string, string]> = [];
  let probeCalls = 0;

  const result = await createDownloadWithProbeRecovery(original, 'old-option', {
    createProbe: async () => {
      probeCalls += 1;
      return refreshed;
    },
    createDownload: async (probeId, optionId) => {
      downloadCalls.push([probeId, optionId]);
      if (downloadCalls.length === 1) throw new ApiClientError('expired', 'JOB_NOT_FOUND');
      return readyDownloadFixture;
    },
  });

  assert.equal(probeCalls, 1);
  assert.deepEqual(downloadCalls, [
    ['expired-probe', 'old-option'],
    ['fresh-probe', 'new-option'],
  ]);
  assert.equal(result.refreshed, true);
  assert.equal(result.optionId, 'new-option');
});

test('does not loop when the refreshed probe also fails', async () => {
  const original = probeFixture('expired-probe', 'old-option');
  const refreshed = probeFixture('fresh-probe', 'new-option');
  let probeCalls = 0;
  let downloadCalls = 0;

  await assert.rejects(
    createDownloadWithProbeRecovery(original, 'old-option', {
      createProbe: async () => {
        probeCalls += 1;
        return refreshed;
      },
      createDownload: async () => {
        downloadCalls += 1;
        throw new ApiClientError('expired', 'JOB_NOT_FOUND');
      },
    }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'JOB_NOT_FOUND',
  );

  assert.equal(probeCalls, 1);
  assert.equal(downloadCalls, 2);
});

test('stops an expired-probe recovery when the selected quality disappeared', async () => {
  const original = probeFixture('expired-probe', 'old-option');
  const refreshed = probeFixture('fresh-probe', 'new-360p');
  refreshed.media.formats[0] = {
    ...refreshed.media.formats[0],
    label: '360p',
    resolution: '640 x 360',
    width: 640,
    height: 360,
  };
  let downloadCalls = 0;

  await assert.rejects(
    createDownloadWithProbeRecovery(original, 'old-option', {
      createProbe: async () => refreshed,
      createDownload: async () => {
        downloadCalls += 1;
        throw new ApiClientError('expired', 'JOB_NOT_FOUND');
      },
    }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'UNAVAILABLE',
  );

  assert.equal(downloadCalls, 1);
});

function kuaishouFixture(detailId: string, downloadUrl = 'https://video.kwaicdn.com/source.mp4'): string {
  const state = {
    defaultClient: {
      [`VisionVideoDetailPhoto:${detailId}`]: {
        id: detailId,
        caption: '快手公开作品示例',
        coverUrl: 'https://images.yximgs.com/cover.jpg',
        duration: 12_500,
        photoUrl: downloadUrl,
        timestamp: 1_725_000_000_000,
        viewCount: 42,
        width: 1080,
        height: 1920,
      },
      'VisionVideoDetailAuthor:author-1': {
        id: 'author-1',
        name: '示例作者',
      },
      [`$ROOT_QUERY.visionVideoDetail({"page":"detail","photoId":"${detailId}"})`]: {
        photo: { id: `VisionVideoDetailPhoto:${detailId}` },
        author: { id: 'VisionVideoDetailAuthor:author-1' },
      },
    },
  };
  return `<html><script>${'window.__APOLLO_STATE__='}${JSON.stringify(state)};(function(){})();</script></html>`;
}

const syntaxOnlyValidator = async (rawUrl: unknown): Promise<URL> => validateUrlSyntax(rawUrl);

test('revalidates every Kuaishou media redirect before returning the stream', async () => {
  const validatedUrls: string[] = [];
  const validatePublicUrl = async (rawUrl: unknown): Promise<URL> => {
    const parsed = await syntaxOnlyValidator(rawUrl);
    validatedUrls.push(parsed.href);
    return parsed;
  };
  let fetchCalls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity');
    if (fetchCalls === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://media.yximgs.com/final.mp4' },
      });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' },
    });
  }) as typeof fetch;
  const controller = new AbortController();

  const response = await fetchTrustedKuaishouMedia('https://video.kwaicdn.com/source.mp4', {
    fetchImpl,
    validatePublicUrl,
    referer: 'https://www.kuaishou.com/short-video/3xiskijer2ktxcc',
    signal: controller.signal,
  });

  assert.equal(fetchCalls, 2);
  assert.deepEqual(validatedUrls, [
    'https://video.kwaicdn.com/source.mp4',
    'https://media.yximgs.com/final.mp4',
  ]);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3]);
});

test('does not accept a partial Kuaishou media response as a complete file', async () => {
  const fetchImpl = (async () => new Response(new Uint8Array([0, 1]), {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': 'bytes 0-1/4',
    },
  })) as typeof fetch;

  await assert.rejects(
    fetchTrustedKuaishouMedia('https://video.kwaicdn.com/source.mp4', {
      fetchImpl,
      validatePublicUrl: syntaxOnlyValidator,
      referer: 'https://www.kuaishou.com/short-video/3xiskijer2ktxcc',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'DOWNLOAD_FAILED',
  );
});

test('rejects a private Kuaishou media redirect before making another request', async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://127.0.0.1/private.mp4' },
    });
  }) as typeof fetch;

  await assert.rejects(
    fetchTrustedKuaishouMedia('https://video.kwaicdn.com/source.mp4', {
      fetchImpl,
      validatePublicUrl: syntaxOnlyValidator,
      referer: 'https://www.kuaishou.com/short-video/3xiskijer2ktxcc',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'PRIVATE_ADDRESS',
  );
  assert.equal(fetchCalls, 1);
});

test('resolves a Kuaishou share link into an opaque direct source', async () => {
  const detailId = '3xiskijer2ktxcc';
  const canonicalUrl = `https://www.kuaishou.com/short-video/${detailId}`;
  let callCount = 0;
  let leakedCookieToRedirectDomain = false;
  let receivedScopedCookie = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://v.m.chenzhongtech.com/fw/long-video/${detailId}`,
          'Set-Cookie': 'did=anonymous-session; Domain=.kuaishou.com; Path=/; Secure',
        },
      });
    }
    if (callCount === 2) {
      leakedCookieToRedirectDomain = Boolean(new Headers(init?.headers).get('cookie'));
      return new Response(null, {
        status: 302,
        headers: {
          Location: canonicalUrl,
          'Set-Cookie': 'redirect_session=mobile; Domain=.chenzhongtech.com; Path=/; Secure',
        },
      });
    }
    assert.equal(new URL(String(input)).hostname, 'www.kuaishou.com');
    receivedScopedCookie = new Headers(init?.headers).get('cookie') === 'did=anonymous-session';
    return new Response(kuaishouFixture(detailId), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  const result = await probeKuaishou(new URL('https://v.kuaishou.com/JT195ZHT'), {
    fetchImpl,
    validatePublicUrl: syntaxOnlyValidator,
  });

  assert.equal(callCount, 3);
  assert.equal(leakedCookieToRedirectDomain, false);
  assert.equal(receivedScopedCookie, true);
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(result.downloadUrl, 'https://video.kwaicdn.com/source.mp4');
  assert.equal(result.media.platform.id, 'kuaishou');
  assert.equal(result.media.author, '示例作者');
  assert.equal(result.media.formats[0].label, '1080p');
});

test('rejects cross-domain redirects and private derived media URLs', async () => {
  const redirectFetch = (async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://evil.example/short-video/3xiskijer2ktxcc' },
  })) as typeof fetch;
  await assert.rejects(
    probeKuaishou(new URL('https://v.kuaishou.com/JT195ZHT'), {
      fetchImpl: redirectFetch,
      validatePublicUrl: syntaxOnlyValidator,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED',
  );

  const privateMediaFetch = (async () => new Response(
    kuaishouFixture('3xiskijer2ktxcc', 'https://127.0.0.1/private.mp4'),
    { status: 200 },
  )) as typeof fetch;
  await assert.rejects(
    probeKuaishou(new URL('https://www.kuaishou.com/short-video/3xiskijer2ktxcc'), {
      fetchImpl: privateMediaFetch,
      validatePublicUrl: syntaxOnlyValidator,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'PRIVATE_ADDRESS',
  );
});

test('requires HTTPS for the initial Kuaishou page and every redirect hop', async () => {
  const unexpectedFetch = (async () => {
    assert.fail('an insecure URL must be rejected before it is fetched');
  }) as typeof fetch;
  await assert.rejects(
    probeKuaishou(new URL('http://www.kuaishou.com/short-video/3xiskijer2ktxcc'), {
      fetchImpl: unexpectedFetch,
      validatePublicUrl: syntaxOnlyValidator,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED',
  );

  let callCount = 0;
  const redirectFetch = (async () => {
    callCount += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://www.kuaishou.com/short-video/3xiskijer2ktxcc' },
    });
  }) as typeof fetch;
  await assert.rejects(
    probeKuaishou(new URL('https://v.kuaishou.com/JT195ZHT'), {
      fetchImpl: redirectFetch,
      validatePublicUrl: syntaxOnlyValidator,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED',
  );
  assert.equal(callCount, 1);
});

test('reports Kuaishou platform verification when the public detail is withheld', async () => {
  const detailId = '3xiskijer2ktxcc';
  const state = {
    defaultClient: {
      [`$ROOT_QUERY.visionVideoDetail({"page":"detail","photoId":"${detailId}"})`]: {
        status: 2,
        photo: null,
      },
    },
  };
  const fetchImpl = (async () => new Response(
    `<script>window.__APOLLO_STATE__=${JSON.stringify(state)}</script>`,
    { status: 200 },
  )) as typeof fetch;

  await assert.rejects(
    probeKuaishou(new URL(`https://www.kuaishou.com/short-video/${detailId}`), {
      fetchImpl,
      validatePublicUrl: syntaxOnlyValidator,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED',
  );
});
