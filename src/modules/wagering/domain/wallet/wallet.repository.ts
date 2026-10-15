import type { Wallet } from "./wallet";

export interface WalletRepository {
  lockById(walletId: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
}
