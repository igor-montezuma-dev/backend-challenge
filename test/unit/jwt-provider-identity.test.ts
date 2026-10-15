import { beforeAll, describe, expect, test } from "bun:test";
import { type JWK, type KeyLike, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { JwtProviderIdentityAdapter, type JwtAuthSettings } from "../../src/auth/jwt-provider-identity.adapter";
import { TransientInfrastructureError } from "../../src/shared/application/errors";

const settings: JwtAuthSettings = {
  issuer: "http://issuer.test/realms/wagering",
  audience: "wagering-processor",
  jwksUrl: "http://127.0.0.1:1/certs",
  providerClaim: "azp",
};

let signingKey: KeyLike;
let foreignKey: KeyLike;
let adapter: JwtProviderIdentityAdapter;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  adapter = new JwtProviderIdentityAdapter(settings, createLocalJWKSet({ keys: [jwk] }));
});

interface TokenOptions {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  key?: KeyLike;
}

function token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ azp: "provider-a", ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? settings.issuer)
    .setAudience(options.audience ?? settings.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(options.key ?? signingKey);
}

const bearer = async (options?: TokenOptions) => ({ authorization: `Bearer ${await token(options)}` });

describe("JwtProviderIdentityAdapter", () => {
  test("token válido: identifica o provedor pela claim configurada", async () => {
    expect(await adapter.resolve(await bearer())).toEqual({ kind: "provider", providerId: "provider-a" });
  });

  test.each([
    ["sem header", {}],
    ["esquema diferente de Bearer", { authorization: "Basic dXNlcjpwYXNz" }],
    ["token malformado", { authorization: "Bearer not-a-jwt" }],
  ])("%s → sem identidade", async (_label, headers) => {
    expect(await adapter.resolve(headers)).toBeUndefined();
  });

  test.each([
    ["expirado", { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
    ["emissor errado", { issuer: "http://evil.test/realms/wagering" }],
    ["audiência errada", { audience: "another-service" }],
  ])("token %s → sem identidade", async (_label, options) => {
    expect(await adapter.resolve(await bearer(options))).toBeUndefined();
  });

  test("assinado por outra chave → sem identidade", async () => {
    expect(await adapter.resolve(await bearer({ key: foreignKey }))).toBeUndefined();
  });

  test("sem a claim do provedor, ou com valor inseguro → sem identidade", async () => {
    expect(await adapter.resolve(await bearer({ claims: { azp: undefined } }))).toBeUndefined();
    expect(await adapter.resolve(await bearer({ claims: { azp: "provider a; drop" } }))).toBeUndefined();
    expect(await adapter.resolve(await bearer({ claims: { azp: 42 } }))).toBeUndefined();
  });

  test('token sem assinatura (alg "none") → sem identidade', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none" })}.${encode({ azp: "provider-a", iss: settings.issuer, aud: settings.audience, exp: 9_999_999_999 })}.x`;
    expect(await adapter.resolve({ authorization: `Bearer ${unsigned}` })).toBeUndefined();
  });

  test("Identity Provider inalcançável → erro transitório (503), não 401", async () => {
    const unreachable = new JwtProviderIdentityAdapter(settings);
    await expect(unreachable.resolve(await bearer())).rejects.toBeInstanceOf(TransientInfrastructureError);
  });
});
