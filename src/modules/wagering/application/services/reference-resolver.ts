import type { ReferenceContext } from "../../domain/settlement/reference-policy";
import type { WagerTransaction } from "../../domain/transaction/wager-transaction";
import type { WagerTransactionRepository } from "../../domain/transaction/wager-transaction.repository";

export class ReferenceResolver {
  async resolve(transactions: WagerTransactionRepository, transaction: WagerTransaction): Promise<ReferenceContext> {
    if (!transaction.hasReference()) return { reference: undefined, referenceAlreadyReversed: false };

    const reference = await transactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId!,
    );
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal()
        ? await transactions.hasProcessedReversalOf(reference.id)
        : false;
    return { reference, referenceAlreadyReversed };
  }
}
