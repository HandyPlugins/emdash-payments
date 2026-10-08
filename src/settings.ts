import * as z from "zod/mini";
import type { PluginContext } from "emdash/plugin";
import { InputError } from "./domain/model.js";
export const SUCCESS_PATH = "/_emdash/api/plugins/payments/complete";
export const CANCEL_PATH = "/_emdash/api/plugins/payments/canceled";
export function safePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("/") || value.startsWith("//") || /[\\\s\x00-\x1f\x7f%#]/.test(value)) throw new InputError("Return destinations must be same-site paths starting with one slash, without escapes or fragments.");
  const url = new URL(value, "https://site.invalid");
  if (url.origin !== "https://site.invalid" || url.pathname.startsWith("/_emdash/api/plugins/payments/checkout")) throw new InputError("Choose a safe same-site return page, not a checkout link.");
  return url.pathname + url.search;
}
export function siteOrigin(ctx: PluginContext): string {
  const url = new URL(ctx.site.url);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new InputError("Configure an HTTPS site URL (loopback HTTP is allowed for local development).");
  return url.origin;
}
export const settingsInput = z.strictObject({
  stripeKey: z.optional(z.string().check(z.maxLength(300))), stripeWebhookSecret: z.optional(z.string().check(z.maxLength(300))),
  successPath: z.string().check(z.maxLength(500)),
});
export async function saveSettings(ctx: PluginContext, values: unknown) {
  const result = settingsInput.safeParse(values);
  if (!result.success) throw new InputError("Invalid settings form.");
  const v = result.data;
  safePath(v.successPath);
  if (v.stripeKey && !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/.test(v.stripeKey)) throw new InputError("Use a Stripe secret or restricted API key, not a publishable key.");
  if (v.stripeWebhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(v.stripeWebhookSecret)) throw new InputError("Use the endpoint's whsec_ signing secret.");
  if (v.stripeKey) await ctx.settings.set("stripeKey", v.stripeKey);
  if (v.stripeWebhookSecret) await ctx.settings.set("stripeWebhookSecret", v.stripeWebhookSecret);
  await ctx.settings.set("successPath", v.successPath);
}
