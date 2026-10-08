import * as z from "zod/mini";
import type { PluginContext } from "emdash/plugin";
import { idSchema, InputError, now, offerSchema, type Offer } from "./model.js";
import { currencyCode, parseAmount } from "./money.js";
import { siteId, storage } from "../storage.js";
import { stripeProvider } from "../providers/stripe.js";
import { siteOrigin, safePath, SUCCESS_PATH } from "../settings.js";
const offerInput = z.strictObject({ name: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)), description: z.string().check(z.trim(), z.maxLength(500)), amount: z.string().check(z.maxLength(20)), currency: z.string().check(z.length(3)), active: z.boolean() });
export async function saveOffer(ctx: PluginContext, input: unknown, id?: string): Promise<Offer> {
  const parsed = offerInput.safeParse(input);
  if (!parsed.success) throw new InputError("Enter a name (up to 120 characters), description (up to 500), amount, currency, and status.");
  const { amount: text, currency: code, ...fields } = parsed.data;
  const currency = currencyCode(code), amount = parseAmount(text, currency);
  const provider = await stripeProvider(ctx);
  if (!await ctx.settings.get<string>("stripeWebhookSecret")) throw new InputError("Configure Stripe's webhook signing secret before creating an offer.");
  const db = storage(ctx);
  if (id && !idSchema.safeParse(id).success) throw new InputError("Invalid offer.");
  const current = id ? await db.offers.getVersioned(id) : null;
  if (id && (!current || !offerSchema.safeParse(current.value).success)) throw new InputError("Offer unavailable.");
  if (current?.value.binding && current.value.binding.testMode !== provider.testMode) throw new InputError("Use the credentials that created this offer. Create a separate offer when changing Stripe mode.");
  const previous = current?.value;
  const pending = previous?.sync;
  if (pending && (previous!.amount !== amount || previous!.currency !== currency || previous!.name !== fields.name || previous!.description !== fields.description || previous!.active !== fields.active || pending.testMode !== provider.testMode)) throw new InputError("This offer has an unfinished Stripe update. Retry with the saved values before making other changes.");
  if (pending && pending.leaseUntil > now()) throw new InputError("This offer is being saved. Wait a minute and reload before retrying.");
  // Stripe retains idempotency keys for at least 24h; uncertain operations must
  // never be replayed after that window with a new key and duplicate side effects.
  if (pending && Date.now() - Date.parse(pending.startedAt) > 23 * 60 * 60 * 1000) throw new InputError("This interrupted update is too old to retry safely. Inspect Stripe's request logs and contact support before changing it.");
  const time = now();
  const recreate = pending?.recreate ?? (!previous?.binding || previous.amount !== amount || previous.currency !== currency || previous.name !== fields.name || previous.description !== fields.description);
  const operationId = pending?.id ?? crypto.randomUUID();
  const site = pending?.siteId ?? await siteId(ctx);
  const successUrl = pending?.successUrl ?? siteOrigin(ctx) + safePath(await ctx.settings.get("successPath") ?? SUCCESS_PATH);
  const offer: Offer = { ...previous, ...fields, id: id ?? crypto.randomUUID(), amount, currency, provider: "stripe", createdAt: previous?.createdAt ?? time, updatedAt: time, schemaVersion: 1,
    sync: { id: operationId, siteId: site, successUrl, testMode: provider.testMode, recreate, startedAt: pending?.startedAt ?? time, leaseUntil: new Date(Date.now() + 60_000).toISOString() }, diagnostic: undefined };
  const claim = await db.offers.compareAndSet(offer.id, current?.revision ?? null, offer);
  if (!claim.applied) throw new InputError("Offer changed. Reload it before saving.");
  try {
    let binding = offer.binding;
    if (recreate) {
      // Disable the previous public link before replacing price/name/currency.
      if (binding) await provider.setLinkActive(binding.id, false, operationId);
      await db.versions.compareAndSet(operationId, null, { id: operationId, offerId: offer.id, name: offer.name, amount, currency, testMode: provider.testMode, createdAt: time, schemaVersion: 1 });
      const link = await provider.createOfferLink(offer, site, successUrl, operationId);
      const snapshot = await db.versions.getVersioned(operationId);
      if (!snapshot || !(await db.versions.compareAndSet(operationId, snapshot.revision, { ...snapshot.value, providerLinkId: link.id })).applied) throw new Error("Offer snapshot conflict");
      binding = { ...link, versionId: operationId };
      if (!offer.active) await provider.setLinkActive(link.id, false, operationId);
    } else {
      await provider.setLinkActive(binding!.id, offer.active, operationId);
    }
    const saved: Offer = { ...offer, binding, sync: undefined, diagnostic: undefined, updatedAt: now() };
    if (!(await db.offers.compareAndSet(offer.id, claim.revision, saved)).applied) throw new Error("Offer checkpoint conflict");
    return saved;
  } catch {
    await db.offers.compareAndSet(offer.id, claim.revision, { ...offer, diagnostic: "provider_sync_failed", sync: { ...offer.sync!, leaseUntil: now() } });
    throw new InputError("Stripe could not save the offer. Open Offers, edit the pending offer and save its unchanged values to retry. Check credentials and Stripe request logs. Its previous link may be inactive.");
  }
}
