import Stripe from "stripe";
import type { PluginContext } from "emdash/plugin";
import { InputError, type Offer } from "../domain/model.js";
import type { CheckoutState, PaymentProvider, VerifiedEvent } from "./types.js";
export const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"] as const;
export async function stripeProvider(ctx: PluginContext): Promise<PaymentProvider> {
  const key = await ctx.settings.get<string>("stripeKey");
  if (!key || !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/.test(key)) throw new InputError("Stripe is not configured. Add a secret or restricted API key in Settings.");
  return new StripeProvider(ctx, key);
}
class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly testMode: boolean;
  private readonly client: Stripe;
  constructor(ctx: PluginContext, key: string) {
    this.testMode = key.includes("_test_");
    this.client = new Stripe(key, {
      httpClient: Stripe.createFetchHttpClient((url, init) => ctx.http!.fetch(String(url), init)),
      telemetry: false, maxNetworkRetries: 0, timeout: 5000,
    });
  }
  async createOfferLink(offer: Offer, site: string, successUrl: string, operationId: string) {
    const metadata = { plugin: "payments", site, offer: offer.id, version: operationId };
    const request = (step: string) => ({ idempotencyKey: `payments-${operationId}-${step}` });
    const product = await this.client.products.create({ name: offer.name, ...(offer.description ? { description: offer.description } : {}), metadata }, request("product"));
    const price = await this.client.prices.create({ product: product.id, currency: offer.currency, unit_amount: offer.amount, metadata }, request("price"));
    const link = await this.client.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1, adjustable_quantity: { enabled: false } }],
      metadata, payment_intent_data: { metadata }, customer_creation: "if_required",
      after_completion: { type: "redirect", redirect: { url: successUrl } },
      allow_promotion_codes: false, automatic_tax: { enabled: false },
    }, request("link"));
    if (!/^plink_[A-Za-z0-9_]+$/.test(link.id) || new URL(link.url).origin !== "https://buy.stripe.com" || link.livemode === this.testMode) throw new Error("Unexpected provider link response");
    return { id: link.id, url: link.url, testMode: !link.livemode };
  }
  async setLinkActive(id: string, active: boolean, operationId: string) {
    const result = await this.client.paymentLinks.update(id, { active }, { idempotencyKey: `payments-${operationId}-${id}-${active ? "activate" : "deactivate"}` });
    if (result.id !== id || result.active !== active || result.livemode === this.testMode) throw new Error("Unexpected link activation response");
  }
  async verifyWebhook(bytes: Uint8Array, signature: string, secret: string): Promise<VerifiedEvent> {
    const event = await this.client.webhooks.constructEventAsync(bytes, signature, secret, 300, Stripe.createSubtleCryptoProvider());
    if (!/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || typeof event.type !== "string" || event.type.length > 150 || typeof event.livemode !== "boolean" || !event.data || !event.data.object) throw new Error("Invalid provider event");
    const recognized = (EVENTS as readonly string[]).includes(event.type);
    const obj = event.data.object;
    if (recognized && (obj.object !== "checkout.session" || !/^cs_[A-Za-z0-9_]{1,200}$/.test(obj.id))) throw new Error("Invalid checkout event");
    return { id: event.id, type: event.type, testMode: !event.livemode, ...(recognized && obj.object === "checkout.session" ? { checkoutId: obj.id } : {}) };
  }
  async readCheckout(id: string): Promise<CheckoutState> {
    const session = await this.client.checkout.sessions.retrieve(id, { expand: ["payment_intent"] });
    if (session.id !== id || session.mode !== "payment" || session.metadata?.plugin !== "payments") {
      return { checkoutId: session.id, amount: null, currency: null, status: "pending", testMode: !session.livemode };
    }
    const intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
    const status = session.status === "complete" && session.payment_status === "paid" ? "succeeded"
      : session.status === "expired" || intent?.status === "canceled" ? "canceled"
      : intent?.status === "requires_payment_method" && intent.last_payment_error ? "failed" : "pending";
    const details = session.customer_details;
    const customer = status === "succeeded" ? {
      ...(typeof session.customer === "string" ? { providerCustomerId: session.customer } : {}),
      ...(details?.email ? { email: details.email.trim().toLowerCase().slice(0, 254) } : {}),
      ...(details?.name ? { name: details.name.slice(0, 200) } : {}),
      ...(details?.address?.country && /^[A-Z]{2}$/.test(details.address.country) ? { country: details.address.country } : {}),
    } : undefined;
    return { checkoutId: session.id, ...(typeof session.payment_intent === "string" ? { paymentId: session.payment_intent } : intent ? { paymentId: intent.id } : {}),
      providerLinkId: typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id,
      versionId: session.metadata?.version, offerId: session.metadata?.offer,
      siteId: session.metadata?.site, pluginId: session.metadata?.plugin,
      amount: session.amount_total, currency: session.currency, status, testMode: !session.livemode, customer };
  }
  async testConnection() { await this.client.balance.retrieve(); }
}
