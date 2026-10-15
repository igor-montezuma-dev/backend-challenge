import { type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from "jose";
import { TransientInfrastructureError } from "../shared/application/errors";
import type { ProviderIdentity, ProviderIdentityPort, RequestHeaders } from "./provider-identity.port";

export interface JwtAuthSettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  providerClaim: string;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/;
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ACCEPTED_ALGORITHMS = ["RS256", "PS256", "ES256"];
const CLOCK_TOLERANCE_SECONDS = 5;
const IDENTITY_PROVIDER_RETRY_AFTER_SECONDS = 5;

export class JwtProviderIdentityAdapter implements ProviderIdentityPort {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly settings: JwtAuthSettings,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(settings.jwksUrl), { timeoutDuration: 3_000, cooldownDuration: 30_000 });
  }

  async resolve(headers: RequestHeaders): Promise<ProviderIdentity | undefined> {
    const token = bearerToken(headers.authorization);
    if (!token) return undefined;

    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ACCEPTED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp", this.settings.providerClaim],
      });
      const providerId = payload[this.settings.providerClaim];
      return typeof providerId === "string" && PROVIDER_ID.test(providerId) ? { kind: "provider", providerId } : undefined;
    } catch (error) {
      if (isKeySetUnavailable(error)) {
        throw new TransientInfrastructureError("identity provider unavailable", IDENTITY_PROVIDER_RETRY_AFTER_SECONDS, error);
      }
      return undefined;
    }
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  return BEARER.exec(header.trim())?.[1];
}

function isKeySetUnavailable(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout) return true;
  if (!(error instanceof errors.JOSEError)) return true;
  return error.code === "ERR_JOSE_GENERIC" && /JSON Web Key Set/i.test(error.message);
}
