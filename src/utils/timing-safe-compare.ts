import { timingSafeEqual } from 'crypto';

/** Constant-time string comparison — avoids leaking length/prefix via timing. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so this branch doesn't
    // short-circuit in a way that's timing-distinguishable from the equal-length case.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
