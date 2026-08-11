const HTTP_URL = /https?:\/\/[^\x00-\x20\x60\x7f-\uffff<>"']+/i;
const TRAILING_SHARE_PUNCTUATION = /[.,;:!?)\]}，。；：！？、）》】」』]+$/u;

/** Extracts the first HTTP(S) URL from either a bare link or mobile share copy. */
export function extractVideoUrlFromText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  const match = value.match(HTTP_URL)?.[0];
  if (!match) return null;

  const candidate = match.replace(TRAILING_SHARE_PUNCTUATION, '');
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
