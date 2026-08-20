/**
 * Typed failures for the finance module.
 *
 * A FinanceError is an EXPECTED outcome — over-allocating a payment, voiding
 * an invoice that already has cash against it — not a bug. Server actions
 * catch it and render `message` inline; anything else propagates as a real
 * 500 because it is one.
 */

export type FinanceErrorCode =
  | "not-found"
  | "invoice-void"
  | "invoice-paid"
  | "invoice-locked"
  | "over-allocation"
  | "over-refund"
  | "payment-void"
  | "invalid-amount"
  | "currency-mismatch"
  | "already-exists"
  | "no-lines";

export class FinanceError extends Error {
  readonly code: FinanceErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: FinanceErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FinanceError";
    this.code = code;
    this.detail = detail;
  }
}

export function isFinanceError(error: unknown): error is FinanceError {
  return error instanceof FinanceError;
}

/**
 * Normalises anything thrown inside a finance mutation into a message safe to
 * put in front of staff. A FinanceError's message is written for them; every
 * other error is deliberately opaque, because it may carry a SQL fragment.
 */
export function financeErrorMessage(error: unknown): string {
  if (isFinanceError(error)) return error.message;
  console.error("[finance] unexpected error", error);
  return "Something went wrong and nothing was saved. The error has been logged.";
}
