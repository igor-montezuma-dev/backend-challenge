import { ApiProperty } from "@nestjs/swagger";
import { MoneyDoc } from "../../../../../shared/infrastructure/http/openapi/common.docs";
import { PLAYER_ID_EXAMPLE, WALLET_ID_EXAMPLE } from "./examples";

export class CreateWalletDoc {
  @ApiProperty({ format: "uuid", example: PLAYER_ID_EXAMPLE })
  playerId!: string;

  @ApiProperty({ type: MoneyDoc, example: { amount: "1000.00", currency: "BRL" } })
  initialBalance!: MoneyDoc;
}

export class WalletCreatedDoc {
  @ApiProperty({ format: "uuid", example: WALLET_ID_EXAMPLE }) id!: string;
  @ApiProperty({ format: "uuid", example: PLAYER_ID_EXAMPLE }) playerId!: string;
  @ApiProperty({ type: MoneyDoc, example: { amount: "1000.00", currency: "BRL" } }) balance!: MoneyDoc;
  @ApiProperty({ example: 1, description: "Começa em 1 e incrementa só quando o saldo muda" }) version!: number;
}

export class WalletDoc extends WalletCreatedDoc {
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}

export class LedgerEntryDoc {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) transactionId!: string;
  @ApiProperty({ example: 2, description: "Versão da wallet após este lançamento" }) walletVersion!: number;
  @ApiProperty({ enum: ["DEBIT", "CREDIT"] }) direction!: string;
  @ApiProperty({ type: MoneyDoc }) money!: MoneyDoc;
  @ApiProperty({ type: MoneyDoc }) balanceBefore!: MoneyDoc;
  @ApiProperty({ type: MoneyDoc }) balanceAfter!: MoneyDoc;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

export class LedgerPageDoc {
  @ApiProperty({ type: [LedgerEntryDoc] }) items!: LedgerEntryDoc[];
  @ApiProperty({ nullable: true, type: String, description: "Cursor opaco para a próxima página; null quando acabou" })
  nextCursor!: string | null;
}

export class ReconciliationDoc {
  @ApiProperty({ format: "uuid" }) walletId!: string;
  @ApiProperty({ type: MoneyDoc, example: { amount: "975.00", currency: "BRL" } }) storedBalance!: MoneyDoc;
  @ApiProperty({ type: MoneyDoc, example: { amount: "975.00", currency: "BRL" } }) calculatedBalance!: MoneyDoc;
  @ApiProperty({ type: MoneyDoc, example: { amount: "0.00", currency: "BRL" } }) difference!: MoneyDoc;
  @ApiProperty({ example: true, description: "false = divergência (logada e contabilizada, nunca corrigida em silêncio)" })
  consistent!: boolean;
  @ApiProperty({ example: 42 }) checkedEntries!: number;
  @ApiProperty({ example: 42 }) walletVersion!: number;
  @ApiProperty({ example: 42, nullable: true, type: Number }) lastEntryVersion!: number | null;
  @ApiProperty({ format: "date-time" }) checkedAt!: string;
}

