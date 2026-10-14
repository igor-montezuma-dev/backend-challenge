/**
 * Ponto de extensão da autenticação (seção 2 do desafio).
 *
 * Decisão: autenticação não foi implementada — não vale pontos e competiria com
 * correção financeira e concorrência. O desenho que seria adotado está no
 * ARCHITECTURE.md: provedores autenticam via OIDC client_credentials num IdP
 * externo (Keycloak), e uma implementação desta porta valida o JWT (assinatura
 * via JWKS, issuer, audience, expiração) e extrai o providerId do claim `azp`.
 */
export interface ProviderIdentity {
  readonly providerId: string;
}

export interface ProviderIdentityPort {
  /**
   * Resolve a identidade a partir dos headers da requisição.
   * Retorna `undefined` quando não há identidade (a requisição é rejeitada).
   */
  resolve(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");
