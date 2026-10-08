import type { PluginContext } from "emdash/plugin";
import type { StorageCollection } from "emdash";
import type { Customer, Offer, OfferVersion, Payment, ProviderEvent } from "./domain/model.js";
export const storage = (ctx: PluginContext) => ({
  offers: ctx.storage.offers as StorageCollection<Offer>,
  versions: ctx.storage.offer_versions as StorageCollection<OfferVersion>,
  customers: ctx.storage.customers as StorageCollection<Customer>,
  payments: ctx.storage.payments as StorageCollection<Payment>,
  events: ctx.storage.provider_events as StorageCollection<ProviderEvent>,
});
export async function siteId(ctx: PluginContext): Promise<string> {
  const current = await ctx.kv.get<string>("identity:site");
  if (current) return current;
  const id = crypto.randomUUID();
  if ((await ctx.kv.compareAndSet("identity:site", null, id)).applied) return id;
  const stored = await ctx.kv.get<string>("identity:site");
  if (!stored) throw new Error("Site identity unavailable");
  return stored;
}
