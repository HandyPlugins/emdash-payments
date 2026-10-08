import { describe, expect, it } from "vitest";
import { amountText, currencyCode, parseAmount } from "../src/domain/money.js";
import { safePath } from "../src/settings.js";
describe("exact money and safe destinations", () => {
  it.each([ ["29.99", "usd", 2999], ["0.10", "eur", 10], ["100", "jpy", 100], ["5", "isk", 500], ["5.00", "ugx", 500], ["1.234", "kwd", 1234] ] as const)("converts %s %s without floating point", (input, currency, expected) => {
    expect(parseAmount(input, currencyCode(currency))).toBe(expected);
    expect(parseAmount(amountText(expected, currency), currency)).toBe(expected);
  });
  it.each([ ["0", "usd"], ["-1", "usd"], ["1e3", "usd"], ["NaN", "usd"], ["1,000", "usd"], ["1.001", "usd"], ["1.1", "jpy"], ["1.01", "isk"], ["1.01", "ugx"], ["1000000", "usd"] ])("rejects invalid monetary input %s %s", (amount, currency) => expect(() => parseAmount(amount, currency)).toThrow());
  it.each(["ZZZ", "US", "USD ", "123", "usd<script>"])("rejects invalid currency %s", currency => expect(() => currencyCode(currency)).toThrow());
  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "/%2f%2fevil.example", "/x\n", "/_emdash/api/plugins/payments/checkout?offer=x", "/done#x"])("rejects unsafe redirect %s", value => expect(() => safePath(value)).toThrow());
  it("accepts same-site paths", () => expect(safePath("/thank-you?from=checkout")).toBe("/thank-you?from=checkout"));
});
