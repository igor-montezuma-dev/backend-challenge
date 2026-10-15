import { ValidationError } from "../../../../shared/domain/domain-error";

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

export const LedgerCursor = {
  encode(afterVersion: number): string {
    return Buffer.from(JSON.stringify({ v: afterVersion }), "utf8").toString("base64url");
  },

  decode(cursor: string | undefined): number {
    if (cursor === undefined || cursor === "") return 0;
    const version = readVersion(cursor);
    if (version === undefined) throw new ValidationError("invalid cursor", "cursor");
    return version;
  },

  limit(raw: string | undefined): number {
    if (raw === undefined || raw === "") return LEDGER_PAGE_DEFAULT_LIMIT;
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    if (!(value >= 1 && value <= LEDGER_PAGE_MAX_LIMIT)) {
      throw new ValidationError(`limit must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`, "limit");
    }
    return value;
  },
};

function readVersion(cursor: string): number | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
    return typeof parsed.v === "number" && Number.isInteger(parsed.v) && parsed.v >= 0 ? parsed.v : undefined;
  } catch {
    return undefined;
  }
}
