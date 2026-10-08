import * as z from "zod/mini";
export class InputError extends Error {}
export const idSchema = z.uuid();
const stamp = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), schemaVersion: z.literal(1) };
export const offerSchema = z.object({
  id: idSchema, name: z.string().check(z.minLength(1), z.maxLength(120)), description: z.string().check(z.maxLength(500)),
  amount: z.int().check(z.positive(), z.maximum(99_999_999)), currency: z.string().check(z.regex(/^[a-z]{3}$/)),
  active: z.boolean(), provider: z.literal("stripe"),
  binding: z.optional(z.object({ id: z.string(), url: z.url(), testMode: z.boolean(), versionId: idSchema })),
  sync: z.optional(z.object({ id: idSchema, leaseUntil: z.iso.datetime(), successUrl: z.url(), siteId: idSchema, testMode: z.boolean(), recreate: z.boolean(), startedAt: z.iso.datetime() })),
  diagnostic: z.optional(z.string()), ...stamp,
});
export type Offer = z.infer<typeof offerSchema>;
export type OfferVersion = { id: string; offerId: string; name: string; amount: number; currency: string; providerLinkId?: string; testMode: boolean; createdAt: string; schemaVersion: 1 };
export const customerSchema = z.object({
  id: z.string(), provider: z.literal("stripe"), providerCustomerId: z.optional(z.string()),
  email: z.optional(z.string()), name: z.optional(z.string()), country: z.optional(z.string()),
  testMode: z.boolean(), ...stamp,
});
export type Customer = z.infer<typeof customerSchema>;
export const statuses = ["pending", "succeeded", "failed", "canceled"] as const;
export const paymentSchema = z.object({
  id: idSchema, provider: z.literal("stripe"), providerPaymentId: z.optional(z.string()),
  providerCheckoutId: z.optional(z.string()), providerEventId: z.optional(z.string()),
  offerId: idSchema, offerName: z.string(), customerId: z.optional(z.string()),
  amount: z.int().check(z.positive(), z.maximum(99_999_999)), currency: z.string(),
  status: z.enum(statuses), testMode: z.boolean(), diagnostic: z.optional(z.string()), ...stamp,
});
export type Payment = z.infer<typeof paymentSchema>;
export type ProviderEvent = {
  provider: "stripe"; providerEventId: string; type: string; testMode: boolean;
  receivedAt: string; processedAt?: string; status: "processing" | "processed" | "ignored" | "failed";
  leaseUntil: string; attempts: number; diagnostic?: string; schemaVersion: 1;
};
export const now = () => new Date().toISOString();
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
