import { randomBytes } from "node:crypto";
import type { IdGenerator } from "../application/id-generator";

const TIMESTAMP_BYTES = 6;
const VERSION_7 = 0x70;
const RFC_4122_VARIANT = 0x80;

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  for (let i = 0; i < TIMESTAMP_BYTES; i++) {
    bytes[i] = Number((timestamp >> BigInt(8 * (TIMESTAMP_BYTES - 1 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | VERSION_7;
  bytes[8] = (bytes[8]! & 0x3f) | RFC_4122_VARIANT;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
