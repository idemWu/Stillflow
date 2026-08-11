import type { IMediaFormat } from './types.js';

function sameTechnicalVariant(left: IMediaFormat, right: IMediaFormat): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.fps === right.fps
    && left.hasAudio === right.hasAudio
    && left.hdr === right.hdr
    && left.extension === right.extension;
}

export function findEquivalentMediaFormat(
  previous: IMediaFormat | undefined,
  candidates: readonly IMediaFormat[],
): IMediaFormat | undefined {
  if (!previous) return undefined;
  return candidates.find((candidate) => sameTechnicalVariant(previous, candidate))
    ?? candidates.find((candidate) => (
      candidate.label === previous.label && candidate.resolution === previous.resolution
    ));
}
