import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { CurrentProvider } from "../../../../auth/current-provider.decorator";
import { Guard } from "../../../../shared/domain/guard";
import { ApiErrorDoc } from "../../../../shared/infrastructure/http/openapi/common.docs";
import { CorrelationId } from "../../../../shared/infrastructure/http/request-context";
import { ProviderMismatchError, TransactionNotFoundError } from "../../application/errors";
import { TRANSACTION_READ_MODEL, type TransactionReadModel } from "../../application/ports/transaction-read-model.port";
import { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction.use-case";
import { FIELD_LIMITS } from "../../domain/transaction/wager-transaction";
import { SubmissionResultDoc, SubmitWagerDoc, TransactionDoc } from "./docs/transaction.docs";
import { SUBMIT_WAGER_EXAMPLES } from "./docs/transaction.examples";
import { TransactionPresenter } from "./transaction.presenter";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

@ApiTags("wagering")
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorDoc, description: "Token ausente, inválido ou expirado" })
@ApiServiceUnavailableResponse({
  type: ApiErrorDoc,
  description: "Falha transitória — nada foi confirmado; reenviar é seguro (Retry-After)",
})
@Controller()
export class WagerTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    @Inject(TRANSACTION_READ_MODEL) private readonly transactions: TransactionReadModel,
  ) {}

  @Post("wagering/transactions")
  @ApiOperation({
    summary: "Submeter transação (BET, WIN, LOSS, REFUND, ROLLBACK)",
    description:
      "Idempotente: reenviar a mesma requisição devolve o resultado original (inclusive o saldo daquele momento) " +
      "com `idempotentReplay: true`. Mesma key com payload diferente é 409. " +
      "Troque o walletId/playerId dos exemplos pelos da wallet criada em POST /wallets.",
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: "Fonte da verdade da idempotência. Padrão: {providerId}:{externalTransactionId}",
    example: "provider-a:transaction-123",
  })
  @ApiBody({ type: SubmitWagerDoc, examples: SUBMIT_WAGER_EXAMPLES })
  @ApiCreatedResponse({ type: SubmissionResultDoc, description: "PROCESSED — aplicada agora" })
  @ApiOkResponse({ type: SubmissionResultDoc, description: "PROCESSED — replay (idempotentReplay: true)" })
  @ApiAcceptedResponse({ type: SubmissionResultDoc, description: "PENDING_REFERENCE — aguardando a transação referenciada" })
  @ApiUnprocessableEntityResponse({
    type: SubmissionResultDoc,
    description: "REJECTED — regra de negócio; ver failureCode e providerAction. Auditável; o replay devolve o mesmo 422.",
  })
  @ApiBadRequestResponse({ type: ApiErrorDoc, description: "Payload inválido ou Idempotency-Key ausente" })
  @ApiNotFoundResponse({ type: ApiErrorDoc, description: "WALLET_NOT_FOUND" })
  @ApiConflictResponse({ type: ApiErrorDoc, description: "IDEMPOTENCY_KEY_CONFLICT ou EXTERNAL_TRANSACTION_ID_CONFLICT" })
  @ApiForbiddenResponse({ type: ApiErrorDoc, description: "PROVIDER_MISMATCH — providerId do corpo difere do provedor autenticado" })
  async submit(
    @Req() request: Request,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @CurrentProvider() actingProviderId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = Guard.text(request.header(IDEMPOTENCY_KEY_HEADER), IDEMPOTENCY_KEY_HEADER, FIELD_LIMITS.idempotencyKey);
    const result = await this.processWager.execute(
      { ...Guard.object(body), idempotencyKey },
      { correlationId, causationId: idempotencyKey, ...(actingProviderId !== undefined ? { actingProviderId } : {}) },
    );
    response.status(TransactionPresenter.httpStatus(result));
    response.setHeader("Location", `/wagering/transactions/${result.transaction.id}`);
    return TransactionPresenter.submission(result);
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({ summary: "Consultar transação pelo id interno" })
  @ApiParam({ name: "transactionId", format: "uuid" })
  @ApiOkResponse({ type: TransactionDoc })
  @ApiBadRequestResponse({ type: ApiErrorDoc })
  @ApiNotFoundResponse({ type: ApiErrorDoc, description: "TRANSACTION_NOT_FOUND" })
  async byId(@Param("transactionId") rawTransactionId: string, @CurrentProvider() actingProviderId: string | undefined) {
    const transaction = await this.transactions.findById(Guard.uuid(rawTransactionId, "transactionId"));
    if (!transaction || !visibleTo(transaction.providerId, actingProviderId)) throw new TransactionNotFoundError();
    return TransactionPresenter.detail(transaction);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Consultar transação pelo id do provedor" })
  @ApiParam({ name: "providerId", example: "provider-a" })
  @ApiParam({ name: "externalTransactionId", example: "transaction-123" })
  @ApiOkResponse({ type: TransactionDoc })
  @ApiNotFoundResponse({ type: ApiErrorDoc, description: "TRANSACTION_NOT_FOUND" })
  @ApiForbiddenResponse({ type: ApiErrorDoc, description: "PROVIDER_MISMATCH — consulta de outro provedor" })
  async byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @CurrentProvider() actingProviderId: string | undefined,
  ) {
    if (actingProviderId !== undefined && actingProviderId !== providerId) {
      throw new ProviderMismatchError(actingProviderId, providerId);
    }
    const transaction = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!transaction) throw new TransactionNotFoundError();
    return TransactionPresenter.detail(transaction);
  }
}

const visibleTo = (ownerProviderId: string, actingProviderId: string | undefined): boolean =>
  actingProviderId === undefined || actingProviderId === ownerProviderId;
