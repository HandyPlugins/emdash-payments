import type { PluginContext } from "emdash/plugin";
import { customerSchema, hash, idSchema, now, paymentSchema, type Customer, type ProviderEvent } from "./model.js";
import type { CheckoutState, PaymentProvider, VerifiedEvent } from "../providers/types.js";
import { siteId, storage } from "../storage.js";
async function customer(ctx: PluginContext, state: CheckoutState, paymentId: string): Promise<string> {
  const details = state.customer ?? {};
  // Email groups guest purchases only; it is never an authentication identity.
  // Distinct provider Customer IDs are never merged just because emails match.
  const identity = details.providerCustomerId ? `provider:${details.providerCustomerId}` : details.email ? `guest:${details.email}` : `anonymous:${paymentId}`;
  const id = await hash(`stripe:${state.testMode}:${identity}`);
  const db = storage(ctx).customers;
  for (let i = 0; i < 4; i++) {
    const current = await db.getVersioned(id);
    const existing = current ? customerSchema.parse(current.value) : null;
    const time = now();
    const value: Customer = { ...existing, ...details, id, provider: "stripe", testMode: state.testMode, createdAt: existing?.createdAt ?? time, updatedAt: time, schemaVersion: 1 };
    if ((await db.compareAndSet(id, current?.revision ?? null, value)).applied) return id;
  }
  throw new Error("Customer update conflict");
}
async function reconcile(ctx: PluginContext, provider: PaymentProvider, event: VerifiedEvent): Promise<boolean> {
  const state = await provider.readCheckout(event.checkoutId!);
  if (state.pluginId !== "payments" || state.siteId !== await siteId(ctx)) return false;
  if (!idSchema.safeParse(state.versionId).success || state.checkoutId !== event.checkoutId) throw new Error("Invalid offer mapping");
  const db = storage(ctx);
  const version = await db.versions.get(state.versionId!);
  if (!version || version.offerId !== state.offerId || version.providerLinkId !== state.providerLinkId || version.amount !== state.amount || version.currency !== state.currency || version.testMode !== state.testMode || event.testMode !== state.testMode || provider.testMode !== state.testMode) throw new Error("Provider state does not match offer snapshot");
  const digest = await hash(`${provider.name}:${state.testMode}:${state.checkoutId}`);
  // Deterministic opaque UUID binds all events for one Checkout Session to one
  // provider-independent local payment, including separate Stripe event IDs.
  const paymentId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await db.payments.getVersioned(paymentId);
    const payment = current ? paymentSchema.parse(current.value) : {
      id: paymentId, provider: provider.name, offerId: version.offerId, offerName: version.name,
      amount: version.amount, currency: version.currency, status: "pending" as const,
      testMode: state.testMode, createdAt: now(), updatedAt: now(), schemaVersion: 1 as const,
    };
    if (payment.provider !== provider.name || payment.offerId !== state.offerId || payment.amount !== state.amount || payment.currency !== state.currency
      || payment.testMode !== state.testMode || event.testMode !== state.testMode || provider.testMode !== state.testMode
      || (payment.providerCheckoutId && payment.providerCheckoutId !== state.checkoutId)
      || (payment.providerPaymentId && payment.providerPaymentId !== state.paymentId)) throw new Error("Provider state does not match payment");
    // Success is terminal for v0.1; failure/cancellation cannot be downgraded to pending.
    const status = payment.status === "succeeded" ? "succeeded" : state.status === "pending" && payment.status !== "pending" ? payment.status : state.status;
    const customerId = state.status === "succeeded" ? await customer(ctx, state, payment.id) : payment.customerId;
    const next = { ...payment, status, ...(customerId ? { customerId } : {}), providerCheckoutId: state.checkoutId,
      ...(state.paymentId ? { providerPaymentId: state.paymentId } : {}), providerEventId: event.id, updatedAt: now(), diagnostic: undefined };
    if ((await db.payments.compareAndSet(payment.id, current?.revision ?? null, next)).applied) return true;
  }
  throw new Error("Payment update conflict");
}
export async function processEvent(ctx: PluginContext, provider: PaymentProvider, event: VerifiedEvent): Promise<void> {
  const db = storage(ctx).events;
  const id = `stripe_${event.testMode ? "test" : "live"}_${event.id}`;
  const current = await db.getVersioned(id);
  if (current?.value.status === "processed" || current?.value.status === "ignored") return;
  if (current?.value.status === "processing" && current.value.leaseUntil > now()) throw new Error("Event processing in progress");
  const value: ProviderEvent = { provider: "stripe", providerEventId: event.id, type: event.type, testMode: event.testMode,
    receivedAt: current?.value.receivedAt ?? now(), status: "processing", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attempts: (current?.value.attempts ?? 0) + 1, schemaVersion: 1 };
  const claim = await db.compareAndSet(id, current?.revision ?? null, value);
  if (!claim.applied) throw new Error("Event claim conflict");
  try {
    const handled = event.checkoutId ? await reconcile(ctx, provider, event) : false;
    if (!(await db.compareAndSet(id, claim.revision, { ...value, status: handled ? "processed" : "ignored", processedAt: now(), leaseUntil: now() })).applied) throw new Error("Event checkpoint conflict");
  } catch {
    await db.compareAndSet(id, claim.revision, { ...value, status: "failed", diagnostic: "reconciliation_failed", leaseUntil: now() });
    throw new Error("Payment could not be reconciled");
  }
}
