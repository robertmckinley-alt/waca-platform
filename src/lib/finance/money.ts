/**
 * ===========================================================================
 *  MONEY — integer cents, always.
 *
 *  Every amount that crosses this module's surface is a whole number of
 *  cents held in a `number`. There is no float arithmetic anywhere in
 *  src/lib/finance, and there must not be: 0.1 + 0.2 is not 0.3, and an
 *  invoice that is one cent short of paid is a phone call from a member who
 *  pays $6,300 a year.
 *
 *  Postgres holds these as `bigint`. JavaScript's safe-integer range is
 *  ±9,007,199,254,740,991 — about $90 trillion — so a `number` is not the
 *  limiting factor. `toCents()` still refuses anything outside it.
 * ===========================================================================
 */

/**
 * A whole number of US cents.
 *
 * Branded so a raw dollar figure cannot be passed where cents are expected.
 * The brand is erased at runtime — a `Money` IS a `number`, and arithmetic on
 * it works normally — it exists purely so `money(6300)` (which would print
 * $63.00) fails to compile where `money(dollars * 100)` was meant.
 */
export type Money = number & { readonly __brand: "cents" };

export const ZERO = 0 as Money;

/** Asserts a value is a whole, finite, safe number of cents. */
export function asMoney(cents: number): Money {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`Amount is not a finite number: ${cents}`);
  }
  if (!Number.isInteger(cents)) {
    throw new RangeError(
      `Amount must be whole cents, got ${cents}. Money is never a float.`,
    );
  }
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Amount is outside the safe integer range: ${cents}`);
  }
  return cents as Money;
}

/** Sums cents without ever leaving integer arithmetic. */
export function sumCents(values: readonly number[]): Money {
  let total = 0;
  for (const v of values) total += Math.round(v);
  return asMoney(total);
}

/** quantity x unitPrice, rounded once, at the end. */
export function lineTotal(
  quantity: number,
  unitPriceCents: number,
  discountCents = 0,
  taxCents = 0,
): Money {
  const gross = Math.round(quantity * unitPriceCents);
  return asMoney(Math.max(0, gross - Math.round(discountCents)) + Math.round(taxCents));
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * THE formatter. 630000 -> "$6,300.00".
 *
 * Formatting happens here, at the edge — never in a SQL expression and never
 * upstream in a query helper.
 */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return usd.format(Number(cents) / 100);
}

/** 630000 -> "$6,300". For dashboard tiles where the pennies are noise. */
export function moneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return usdWhole.format(Number(cents) / 100);
}

/** 630000 -> "6300.00". For CSV and for a form's default value. */
export function moneyPlain(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (Number(cents) / 100).toFixed(2);
}

/**
 * Parses what a human types into cents.
 *
 * Accepts "6300", "6,300", "$6,300.00", " 6300.5 " and "(120.00)" for a
 * negative. Returns null for anything it cannot read, so a caller can render
 * a field error rather than silently bank a zero.
 *
 * Deliberately string-based: `Math.round(parseFloat("1234.565") * 100)` is
 * 123456, not 123457, because 1234.565 is not representable. Splitting on the
 * decimal point and padding the fraction avoids the float entirely.
 */
export function toCents(input: string | number | null | undefined): Money | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return asMoney(Math.round(input * 100));
  }

  let raw = input.trim();
  if (!raw) return null;

  let sign = 1;
  if (/^\(.*\)$/.test(raw)) {
    sign = -1;
    raw = raw.slice(1, -1).trim();
  }
  raw = raw.replace(/^[-+]/, (m) => {
    if (m === "-") sign = -sign;
    return "";
  });
  raw = raw.replace(/[$\s,]/g, "");
  if (!/^\d*(\.\d*)?$/.test(raw) || raw === "" || raw === ".") return null;

  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 2) return null; // fractions of a cent are a typo
  const cents =
    Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return asMoney(sign * cents);
}

/** `toCents` that throws — for trusted, already-validated input. */
export function requireCents(input: string | number): Money {
  const cents = toCents(input);
  if (cents === null) throw new RangeError(`Not a readable amount: "${input}"`);
  return cents;
}
