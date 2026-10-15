import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MoneyDoc } from "../../../../../shared/infrastructure/http/openapi/common.docs";
import { FailureCode } from "../../../domain/transaction/failure-code";
import {
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/transaction/wager-transaction";
import { PLAYER_ID_EXAMPLE, WALLET_ID_EXAMPLE } from "./examples";

const KINDS = [...SUBMITTABLE_KINDS];
const STATUSES = Object.values(WagerTransactionStatus);
const FAILURE_CODES = Object.values(FailureCode);

export class SubmitWagerDoc {
  @ApiProperty({ example: "provider-a", maxLength: 128 }) providerId!: string;
  @ApiProperty({ example: "transaction-123", maxLength: 256 }) externalTransactionId!: string;
  @ApiProperty({ format: "uuid", example: PLAYER_ID_EXAMPLE }) playerId!: string;
  @ApiProperty({ format: "uuid", example: WALLET_ID_EXAMPLE }) walletId!: string;
  @ApiProperty({ example: "round-987" }) roundId!: string;
  @ApiProperty({ example: "fortune-chimp" }) gameId!: string;
  @ApiProperty({ enum: KINDS, example: "BET", description: "OPENING é interno e não pode ser submetido" }) kind!: string;
  @ApiProperty({ type: MoneyDoc, example: { amount: "25.00", currency: "BRL" } }) money!: MoneyDoc;
  @ApiPropertyOptional({
    example: "transaction-100",
    description: "Obrigatório em REFUND/ROLLBACK; opcional em WIN/LOSS; proibido em BET. Id do PROVEDOR, não o interno.",
  })
  referenceExternalTransactionId?: string;
}

export class SubmissionResultDoc {
  @ApiProperty({ format: "uuid" }) transactionId!: string;
  @ApiProperty({ enum: STATUSES, example: "PROCESSED" }) status!: string;
  @ApiProperty({
    type: MoneyDoc,
    nullable: true,
    example: { amount: "975.00", currency: "BRL" },
    description: "Saldo observado quando a transação foi finalizada (o mesmo em todo replay)",
  })
  balance!: MoneyDoc | null;
  @ApiProperty({ example: false }) idempotentReplay!: boolean;
  @ApiPropertyOptional({ enum: FAILURE_CODES }) failureCode?: string;
  @ApiPropertyOptional({ enum: ["do-not-retry", "fix-and-resend", "retry-later"] }) providerAction?: string;
}

export class TransactionDoc {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() externalTransactionId!: string;
  @ApiProperty({ format: "uuid" }) walletId!: string;
  @ApiProperty({ format: "uuid" }) playerId!: string;
  @ApiProperty() roundId!: string;
  @ApiProperty() gameId!: string;
  @ApiProperty({ enum: Object.values(WagerTransactionKind) }) kind!: string;
  @ApiProperty({ type: MoneyDoc }) money!: MoneyDoc;
  @ApiProperty({ nullable: true, type: String }) referenceExternalTransactionId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: "uuid" }) referenceTransactionId!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ nullable: true, enum: FAILURE_CODES }) failureCode!: string | null;
  @ApiProperty({ type: MoneyDoc, nullable: true }) balanceAfter!: MoneyDoc | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time", nullable: true, type: String }) processedAt!: string | null;
}

