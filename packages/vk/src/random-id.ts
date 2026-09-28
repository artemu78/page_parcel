import * as crypto from 'node:crypto';

export function generateStableRandomId(seed: string): number {
  const hash = crypto.createHash('sha256').update(seed).digest();
  // Read first 4 bytes as unsigned 32-bit integer, and mask to positive 31-bit int
  const int32 = hash.readUInt32BE(0) & 0x7fffffff;
  return int32 || 1; // non-zero
}
