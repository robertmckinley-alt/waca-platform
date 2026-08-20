/**
 * CSV export. Every admin list view offers one, and they all go through here
 * so quoting and the filename convention stay identical.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  // Guard against spreadsheet formula injection on =, +, -, @ and tab/CR.
  // A plain number is exempt: "-34" must stay a number, not become text.
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(s);
  const needsPrefix = !looksNumeric && /^[=+\-@\t\r]/.test(s);
  const body = needsPrefix ? `'${s}` : s;
  if (/[",\n\r]/.test(body)) return `"${body.replace(/"/g, '""')}"`;
  return body;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeCell(c.value(row))).join(","),
  );
  // BOM so Excel opens UTF-8 correctly.
  return `﻿${[head, ...body].join("\r\n")}\r\n`;
}

export function csvResponse(csv: string, filenameStem: string): Response {
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="waca-${filenameStem}-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/** Cents -> a plain decimal string so spreadsheets treat it as a number. */
export function csvCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (Number(cents) / 100).toFixed(2);
}

export function csvDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
