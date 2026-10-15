export type ProviderIdentity =
  | { readonly kind: "provider"; readonly providerId: string }
  | { readonly kind: "anonymous" };

export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface ProviderIdentityPort {
  resolve(headers: RequestHeaders): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");
