import { randomBytes } from "node:crypto";

/**
 * UUID v7 (RFC 9562): 48 bits de timestamp em ms + aleatoriedade.
 * Ordenável no tempo — bom para PK em B-tree e para cursores de paginação.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // versão 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Porta para geração de ids — testes injetam uma sequência determinística. */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol("ID_GENERATOR");

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
