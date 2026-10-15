import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiBearerAuth,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Guard } from "../../../../shared/domain/guard";
import { ApiErrorDoc } from "../../../../shared/infrastructure/http/openapi/common.docs";
import { CorrelationId } from "../../../../shared/infrastructure/http/request-context";
import { WalletNotFoundError } from "../../application/errors";
import { WALLET_READ_MODEL, type WalletReadModel } from "../../application/ports/wallet-read-model.port";
import { OpenWallet } from "../../application/use-cases/open-wallet.use-case";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet.use-case";
import { WALLET_ID_EXAMPLE } from "./docs/examples";
import {
  CreateWalletDoc,
  LedgerPageDoc,
  ReconciliationDoc,
  WalletCreatedDoc,
  WalletDoc,
} from "./docs/wallet.docs";
import { LEDGER_PAGE_DEFAULT_LIMIT, LEDGER_PAGE_MAX_LIMIT, LedgerCursor } from "./ledger-cursor";
import { WalletPresenter } from "./wallet.presenter";

const WALLET_ID_PARAM = { name: "walletId", format: "uuid", example: WALLET_ID_EXAMPLE } as const;

@ApiTags("wallets")
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorDoc, description: "Token ausente, inválido ou expirado" })
@ApiServiceUnavailableResponse({ type: ApiErrorDoc, description: "PostgreSQL indisponível — reenviar é seguro" })
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly reconcileWallet: ReconcileWallet,
    @Inject(WALLET_READ_MODEL) private readonly wallets: WalletReadModel,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Criar wallet",
    description:
      "Saldo inicial > 0 gera, na mesma transação SQL, a transação interna OPENING e o lançamento CREDIT no ledger.",
  })
  @ApiBody({ type: CreateWalletDoc })
  @ApiCreatedResponse({ type: WalletCreatedDoc })
  @ApiBadRequestResponse({ type: ApiErrorDoc, description: "Payload inválido (ex.: amount como number, 3 casas decimais)" })
  @ApiConflictResponse({ type: ApiErrorDoc, description: "WALLET_ALREADY_EXISTS — já existe wallet para player + moeda" })
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const wallet = await this.openWallet.execute(body, { correlationId });
    return WalletPresenter.created(wallet);
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Consultar wallet" })
  @ApiParam(WALLET_ID_PARAM)
  @ApiOkResponse({ type: WalletDoc })
  @ApiBadRequestResponse({ type: ApiErrorDoc })
  @ApiNotFoundResponse({ type: ApiErrorDoc, description: "WALLET_NOT_FOUND" })
  async get(@Param("walletId") rawWalletId: string) {
    return WalletPresenter.detail(await this.existingWallet(rawWalletId));
  }

  @Get(":walletId/ledger")
  @ApiOperation({
    summary: "Ledger da wallet (paginado)",
    description:
      "Ordem cronológica (walletVersion crescente). Cursor opaco e estável: lançamentos novos não deslocam as páginas.",
  })
  @ApiParam(WALLET_ID_PARAM)
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor da página anterior" })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: LEDGER_PAGE_MAX_LIMIT, default: LEDGER_PAGE_DEFAULT_LIMIT },
  })
  @ApiOkResponse({ type: LedgerPageDoc })
  @ApiBadRequestResponse({ type: ApiErrorDoc, description: "cursor ou limit inválidos" })
  @ApiNotFoundResponse({ type: ApiErrorDoc })
  async ledger(
    @Param("walletId") rawWalletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const afterVersion = LedgerCursor.decode(cursor);
    const pageSize = LedgerCursor.limit(limit);
    const wallet = await this.existingWallet(rawWalletId);

    const page = await this.wallets.ledgerPage(wallet.id, afterVersion, pageSize);
    return {
      items: page.entries.map(WalletPresenter.ledgerEntry),
      nextCursor: page.nextAfterVersion !== undefined ? LedgerCursor.encode(page.nextAfterVersion) : null,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reconciliar saldo × ledger",
    description:
      "Compara o saldo materializado com o saldo reconstruído pelo ledger, no mesmo snapshot e sem travar a wallet. " +
      "Divergência é sinalizada (consistent: false), logada e contabilizada — nunca corrigida silenciosamente.",
  })
  @ApiParam(WALLET_ID_PARAM)
  @ApiOkResponse({ type: ReconciliationDoc })
  @ApiNotFoundResponse({ type: ApiErrorDoc })
  async reconcile(@Param("walletId") rawWalletId: string) {
    const report = await this.reconcileWallet.execute(Guard.uuid(rawWalletId, "walletId"));
    return WalletPresenter.reconciliation(report);
  }

  private async existingWallet(rawWalletId: string) {
    const walletId = Guard.uuid(rawWalletId, "walletId");
    const wallet = await this.wallets.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
