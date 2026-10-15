import { FailureCode } from "../transaction/failure-code";
import type { WagerTransaction } from "../transaction/wager-transaction";

export type ReferenceVerdict =
  | { kind: "not_applicable" }
  | { kind: "await" }
  | { kind: "eligible"; reference: WagerTransaction }
  | { kind: "ineligible"; code: FailureCode };

export interface ReferenceContext {
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
}

export const ReferencePolicy = {
  evaluate(transaction: WagerTransaction, { reference, referenceAlreadyReversed }: ReferenceContext): ReferenceVerdict {
    if (!transaction.hasReference()) return { kind: "not_applicable" };
    if (!reference || reference.isAwaitingSettlement()) return { kind: "await" };

    const violation = firstViolation(transaction, reference, referenceAlreadyReversed);
    return violation ? { kind: "ineligible", code: violation } : { kind: "eligible", reference };
  },
};

function firstViolation(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  referenceAlreadyReversed: boolean,
): FailureCode | undefined {
  if (!reference.isProcessed()) return FailureCode.ReferenceNotProcessed;
  if (!transaction.sharesContextWith(reference)) return FailureCode.ReferenceMismatch;
  if (!transaction.canReference(reference)) return FailureCode.InvalidReferenceKind;
  if (transaction.isReversal() && !transaction.money.equals(reference.money)) return FailureCode.ReversalAmountMismatch;
  if (transaction.isReversal() && referenceAlreadyReversed) return FailureCode.AlreadyReversed;
  return undefined;
}
