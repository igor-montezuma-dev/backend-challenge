import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../src/shared/domain/domain-error";
import { Guard } from "../../src/shared/domain/guard";
import { canonicalJson, fingerprint } from "../../src/shared/domain/fingerprint";

describe("Guard", () => {
  test("uuid normaliza para minúsculas e rejeita o resto", () => {
    expect(Guard.uuid("0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1", "id")).toBe("0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1");
    for (const bad of ["", "abc", 42, null, "0192f28f5dc07d58bdb2814ad6a0f4a1"]) {
      expect(() => Guard.uuid(bad, "id")).toThrow(ValidationError);
    }
  });

  test("text exige string não vazia dentro do limite", () => {
    expect(Guard.text("ok", "f", 2)).toBe("ok");
    for (const bad of ["", "   ", "abc", 1, undefined]) expect(() => Guard.text(bad, "f", 2)).toThrow(ValidationError);
  });

  test("optionalText aceita ausência", () => {
    expect(Guard.optionalText(undefined, "f", 5)).toBeUndefined();
    expect(Guard.optionalText(null, "f", 5)).toBeUndefined();
    expect(() => Guard.optionalText("", "f", 5)).toThrow(ValidationError);
  });

  test("oneOf e object", () => {
    expect(Guard.oneOf("BET", "kind", ["BET", "WIN"] as const)).toBe("BET");
    expect(() => Guard.oneOf("OPENING", "kind", ["BET"] as const)).toThrow(ValidationError);
    expect(() => Guard.object([])).toThrow(ValidationError);
    expect(Guard.object({ a: 1 })).toEqual({ a: 1 });
  });

  test("o erro identifica o campo", () => {
    try {
      Guard.uuid("x", "walletId");
    } catch (error) {
      expect((error as ValidationError).field).toBe("walletId");
    }
  });
});

describe("fingerprint", () => {
  test("JSON canônico independe da ordem das chaves e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, "x"] }, z: undefined })).toBe('{"a":{"c":[1,"x"],"d":2},"b":1}');
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
