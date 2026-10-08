import { InputError } from "./model.js";
// ISO validation uses the runtime's maintained currency data; the provider remains
// authoritative about account/country/payment-method availability and minimums.
const currencies = new Set(Intl.supportedValuesOf("currency").map(c => c.toLowerCase()));
const zero = new Set("bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf".split(" "));
export function currencyCode(input: unknown): string {
  if (typeof input !== "string" || !/^[a-zA-Z]{3}$/.test(input) || !currencies.has(input.toLowerCase())) throw new InputError("Enter a valid three-letter ISO currency code, such as USD or EUR.");
  return input.toLowerCase();
}
export function decimals(currency: string): number {
  if (currency === "isk" || currency === "ugx") return 2;
  if (zero.has(currency)) return 0;
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!;
}
export function parseAmount(value: unknown, currency: string): number {
  const digits = decimals(currency);
  if (typeof value !== "string" || !/^\d{1,8}(?:\.\d{1,3})?$/.test(value)) throw new InputError("Enter a positive amount using a decimal point, without currency symbols or grouping separators.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits || ((currency === "isk" || currency === "ugx") && /[1-9]/.test(fraction))) throw new InputError(`This currency requires ${currency === "isk" || currency === "ugx" ? "whole units" : `at most ${digits} decimal places`}.`);
  const minor = BigInt(whole + fraction.padEnd(digits, "0"));
  if (minor < 1n || minor > 99_999_999n) throw new InputError("Amount must be positive and no more than 99,999,999 minor units.");
  return Number(minor);
}
export function amountText(amount: number, currency: string): string {
  const places = decimals(currency);
  const text = String(amount).padStart(places + 1, "0");
  return places ? `${text.slice(0, -places)}.${text.slice(-places)}` : text;
}
export const money = (amount: number, currency: string) => `${amountText(amount, currency)} ${currency.toUpperCase()}`;
