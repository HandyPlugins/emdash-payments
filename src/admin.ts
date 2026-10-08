import * as z from "zod/mini";
import type { Block, BlockResponse, ButtonElement } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { customerSchema, idSchema, InputError, offerSchema, paymentSchema, type Offer } from "./domain/model.js";
import { amountText, money } from "./domain/money.js";
import { saveOffer } from "./domain/offers.js";
import { storage } from "./storage.js";
import { saveSettings, siteOrigin, SUCCESS_PATH } from "./settings.js";
import { EVENTS, stripeProvider } from "./providers/stripe.js";
const button = (action_id: string, label: string, value?: string): ButtonElement => ({ type: "button", action_id, label, ...(value ? { value } : {}) });
const nav: Block = { type: "actions", elements: [button("payments", "Payments"), button("offers", "Offers"), button("customers", "Customers"), button("settings", "Settings")] };
const screen = (title: string, blocks: Block[]): BlockResponse => ({ blocks: [{ type: "header", text: title }, nav, ...blocks] });
const interaction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_load"), page: z.literal("/manage") }),
  z.object({ type: z.literal("block_action"), action_id: z.enum(["payments", "offers", "customers", "settings", "new", "edit", "link", "purchases", "test_connection", "clear_key", "clear_webhook"]), value: z.optional(z.string().check(z.maxLength(2000))), block_id: z.optional(z.string().check(z.maxLength(200))), page: z.optional(z.literal("/manage")) }),
  z.object({ type: z.literal("form_submit"), action_id: z.enum(["save_offer", "save_settings"]), values: z.record(z.string(), z.unknown()), block_id: z.optional(z.string().check(z.maxLength(200))), page: z.optional(z.literal("/manage")) }),
]);
async function payments(ctx: PluginContext, cursor?: string, customerId?: string): Promise<BlockResponse> {
  const db = storage(ctx);
  const result = await db.payments.query({ where: customerId ? { customerId } : undefined, orderBy: { createdAt: "desc" }, limit: 30, cursor });
  const customerIds = result.items.map(row => paymentSchema.parse(row.data).customerId).filter((id): id is string => !!id);
  const names = customerIds.length ? await db.customers.getMany([...new Set(customerIds)]) : new Map();
  return screen(customerId ? "Customer purchases" : "Payments", [
    { type: "section", text: "Accept payments on your EmDash site without a full commerce platform." },
    ...(customerId ? [] : [{ type: "fields" as const, fields: [{ label: "Successful payments", value: String(await db.payments.count({ status: "succeeded" })) }, { label: "Recorded checkouts", value: String(await db.payments.count()) }, { label: "Customers", value: String(await db.customers.count()) }] }]),
    { type: "table", page_action_id: "payments", empty_text: "No payments yet. Add Stripe credentials and your webhook in Settings, create an offer, then copy its checkout link.",
      columns: [{ key: "date", label: "Date", format: "relative_time" }, { key: "customer", label: "Customer" }, { key: "offer", label: "Offer" }, { key: "amount", label: "Amount" }, { key: "provider", label: "Provider" }, { key: "status", label: "Status", format: "badge" }, { key: "mode", label: "Mode" }, { key: "issue", label: "Note" }],
      rows: result.items.map(row => { const p = paymentSchema.parse(row.data); const c = p.customerId ? names.get(p.customerId) : null;
        return { date: p.createdAt, customer: c?.email ?? c?.name ?? "—", offer: p.offerName, amount: money(p.amount, p.currency), provider: "Stripe", status: p.status, mode: p.testMode ? "Test" : "Live", issue: p.diagnostic ? "Checkout request failed; inspect Stripe before retrying." : "" }; }) },
    { type: "context", text: "30 records per page. Records appear after a verified webhook. Pending includes delayed payments. Stripe is the payment authority; refunds are not synchronized in v0.1." },
    ...(result.cursor ? [{ type: "actions" as const, elements: [button(customerId ? "purchases" : "payments", "Next page", customerId ? `${customerId}:${result.cursor}` : result.cursor)] }] : []),
  ]);
}
async function offers(ctx: PluginContext, cursor?: string): Promise<BlockResponse> {
  const result = await storage(ctx).offers.query({ orderBy: { createdAt: "desc" }, limit: 30, cursor });
  return screen("Offers", [
    { type: "actions", elements: [button("new", "Add offer")] },
    { type: "table", page_action_id: "offers", empty_text: "Create your first fixed-price offer, copy its checkout link, and add it to a button or link on your site.",
      columns: [{ key: "name", label: "Name" }, { key: "price", label: "Price" }, { key: "status", label: "Status" }, { key: "edit", label: "Edit", format: "element" }, { key: "checkout", label: "Checkout", format: "element" }],
      rows: result.items.map(row => { const o = offerSchema.parse(row.data); return { name: o.name, price: money(o.amount, o.currency), status: o.sync ? "Pending Stripe update" : o.active ? "Active" : "Inactive", edit: button("edit", "Edit", o.id), checkout: button("link", "Copy link", o.id) }; }) },
    ...(result.cursor ? [{ type: "actions" as const, elements: [button("offers", "Next page", result.cursor)] }] : []),
  ]);
}
function offerForm(offer?: Offer): BlockResponse {
  return screen(offer ? "Edit offer" : "New offer", [
    { type: "section", text: "One offer, one fixed price, quantity 1. Stripe availability and minimums depend on your account and currency." },
    { type: "form", block_id: offer?.id ?? "new-offer", fields: [
      { type: "text_input", action_id: "name", label: "Name", initial_value: offer?.name ?? "" },
      { type: "text_input", action_id: "description", label: "Description (optional)", multiline: true, initial_value: offer?.description ?? "" },
      { type: "text_input", action_id: "amount", label: "Amount", placeholder: "29.00", initial_value: offer ? amountText(offer.amount, offer.currency) : "" },
      { type: "text_input", action_id: "currency", label: "Currency (ISO code)", initial_value: offer?.currency.toUpperCase() ?? "USD" },
      { type: "toggle", action_id: "active", label: "Active", initial_value: offer?.active ?? true },
    ], submit: { action_id: "save_offer", label: "Save offer" } },
    { type: "context", text: "Changing name, description, price or currency replaces the hosted link and disables the old one; update any buttons on your site. Activating/deactivating preserves the URL. Already-open Stripe sessions retain their price and may still be paid. Save unchanged values to retry a pending update." },
  ]);
}
async function offerLink(ctx: PluginContext, id: string): Promise<BlockResponse> {
  const offer = offerSchema.safeParse(await storage(ctx).offers.get(id));
  if (!offer.success) throw new InputError("Offer unavailable.");
  if (offer.data.sync || !offer.data.binding) throw new InputError("The Stripe update is pending. Edit the offer and save its unchanged values to retry before copying a link.");
  const url = offer.data.binding.url;
  return screen("Checkout link", [
    { type: "section", text: `${offer.data.name} — ${money(offer.data.amount, offer.data.currency)}${offer.data.active ? "" : " (inactive)"}` },
    { type: "code", code: url },
    { type: "context", text: "Copy this Stripe-hosted URL and use it as a button or link destination. It supports repeated purchases and remains stable when activating/deactivating the offer. Pricing or product edits create a replacement link." },
  ]);
}
async function customers(ctx: PluginContext, cursor?: string): Promise<BlockResponse> {
  const result = await storage(ctx).customers.query({ orderBy: { createdAt: "desc" }, limit: 30, cursor });
  return screen("Customers", [
    { type: "table", page_action_id: "customers", empty_text: "Customers appear after a verified successful payment.", columns: [{ key: "email", label: "Email" }, { key: "name", label: "Name" }, { key: "country", label: "Country" }, { key: "mode", label: "Mode" }, { key: "purchases", label: "Purchases", format: "element" }],
      rows: result.items.map(row => { const c = customerSchema.parse(row.data); return { email: c.email ?? "—", name: c.name ?? "—", country: c.country ?? "—", mode: c.testMode ? "Test" : "Live", purchases: button("purchases", "View", c.id) }; }) },
    { type: "context", text: "Guest purchases are grouped by exact normalized email within test/live mode. Email is contact information, not verified identity. Different Stripe Customer IDs stay separate." },
    ...(result.cursor ? [{ type: "actions" as const, elements: [button("customers", "Next page", result.cursor)] }] : []),
  ]);
}
async function settings(ctx: PluginContext): Promise<BlockResponse> {
  const key = await ctx.settings.get<string>("stripeKey");
  const webhook = await ctx.settings.get<string>("stripeWebhookSecret");
  const events = await storage(ctx).events.query({ orderBy: { receivedAt: "desc" }, limit: 10 });
  return screen("Settings", [
    { type: "section", text: "1. Add Stripe credentials. 2. Configure the webhook below. 3. Create an offer. 4. Copy its link. 5. Add it to your site." },
    { type: "context", text: `Stripe: ${key ? key.includes("_test_") ? "Test credentials configured" : "Live credentials configured" : "Not configured"}. Webhook: ${webhook ? "Signing secret saved; verify delivery in Stripe" : "Not configured"}.` },
    { type: "form", block_id: "settings", fields: [
      { type: "secret_input", action_id: "stripeKey", label: "Stripe secret/restricted API key (replace)", has_value: !!key },
      { type: "secret_input", action_id: "stripeWebhookSecret", label: "Webhook signing secret (replace)", has_value: !!webhook },
      { type: "text_input", action_id: "successPath", label: "Success destination (same-site path)", initial_value: await ctx.settings.get<string>("successPath") ?? SUCCESS_PATH },
    ], submit: { action_id: "save_settings", label: "Save settings" } },
    { type: "context", text: "Empty secret fields keep existing credentials. Use the confirmed Clear buttons to remove them. Success destinations apply to newly created links. Stripe controls cancellation/back behavior. A success redirect never confirms payment." },
    { type: "actions", elements: [button("test_connection", "Test connection"),
      { ...button("clear_key", "Clear API key"), confirm: { title: "Clear Stripe API key?", text: "Offer updates and webhook reconciliation will stop. Existing hosted links remain active until disabled in Stripe.", confirm: "Clear", deny: "Cancel" } },
      { ...button("clear_webhook", "Clear webhook secret"), confirm: { title: "Clear webhook secret?", text: "Webhook processing and offer updates will stop. Existing hosted links remain active until disabled in Stripe.", confirm: "Clear", deny: "Cancel" } } ] },
    { type: "section", text: "Add this public POST endpoint to Stripe. Select only the four events below and use this endpoint's signing secret." },
    { type: "code", code: `${siteOrigin(ctx)}/_emdash/api/plugins/payments/webhook` },
    { type: "code", code: EVENTS.join("\n") },
    { type: "table", page_action_id: "settings", empty_text: "No verified webhook events received yet.", columns: [{ key: "date", label: "Received", format: "relative_time" }, { key: "type", label: "Event" }, { key: "status", label: "Status" }, { key: "attempts", label: "Attempts" }], rows: events.items.map(row => ({ date: row.data.receivedAt, type: row.data.type, status: row.data.status, attempts: row.data.attempts })) },
    { type: "context", text: "Failed reconciliation returns an error so Stripe retries. Check Stripe delivery logs; no raw webhook payloads are saved. Test connection checks API access only, not webhook delivery or every permission." },
  ]);
}
export async function handleAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  if (!route.user || route.user.role < 50) return screen("Payments", [{ type: "section", text: "Only site administrators can access payments and customer information." }]);
  const parsed = interaction.safeParse(route.input);
  if (!parsed.success) return { ...screen("Payments", []), toast: { type: "error", message: "Invalid admin request." } };
  const input = parsed.data;
  try {
    if (input.type === "page_load") return await payments(ctx);
    if (input.type === "form_submit") {
      if (input.action_id === "save_settings") { await saveSettings(ctx, input.values); return { ...await settings(ctx), toast: { type: "success", message: "Settings saved." } }; }
      if (input.block_id !== "new-offer" && !idSchema.safeParse(input.block_id).success) throw new InputError("Invalid offer form.");
      const offer = await saveOffer(ctx, input.values, input.block_id === "new-offer" ? undefined : input.block_id);
      return { ...await offerLink(ctx, offer.id), toast: { type: "success", message: "Offer saved." } };
    }
    if (input.action_id === "payments") return await payments(ctx, input.value);
    if (input.action_id === "offers") return await offers(ctx, input.value);
    if (input.action_id === "customers") return await customers(ctx, input.value);
    if (input.action_id === "settings") return await settings(ctx);
    if (input.action_id === "new") return offerForm();
    if (input.action_id === "purchases") {
      const [id, ...cursor] = (input.value ?? "").split(":");
      if (!/^[a-f0-9]{64}$/.test(id)) throw new InputError("Invalid customer.");
      return await payments(ctx, cursor.length ? cursor.join(":") : undefined, id);
    }
    if (input.action_id === "edit" || input.action_id === "link") {
      if (!idSchema.safeParse(input.value).success) throw new InputError("Invalid offer.");
      if (input.action_id === "link") return await offerLink(ctx, input.value!);
      const offer = offerSchema.safeParse(await storage(ctx).offers.get(input.value!));
      if (!offer.success) throw new InputError("Offer unavailable.");
      return offerForm(offer.data);
    }
    if (input.action_id === "clear_key" || input.action_id === "clear_webhook") {
      await ctx.settings.delete(input.action_id === "clear_key" ? "stripeKey" : "stripeWebhookSecret");
      return { ...await settings(ctx), toast: { type: "success", message: "Credential cleared." } };
    }
    await (await stripeProvider(ctx)).testConnection();
    return { ...await settings(ctx), toast: { type: "success", message: "Stripe API connection succeeded. Verify webhook delivery separately." } };
  } catch (error) {
    const message = error instanceof InputError ? error.message : "Payments could not complete this action. Check Stripe credentials and permissions, then retry. No provider details or secrets are shown.";
    ctx.log.warn("Payments admin operation failed");
    return { ...screen("Payments", [{ type: "section", text: message }]), toast: { type: "error", message } };
  }
}
