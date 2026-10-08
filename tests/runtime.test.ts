import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { Offer, Payment, Customer, ProviderEvent } from "../src/domain/model.js";
import { EVENTS } from "../src/providers/stripe.js";
let host: PluginRuntimeTestHost;
const key = "sk_test_syntheticPaymentsKey", secret = "whsec_syntheticPaymentsSecret";
const stripe = new Stripe(key), api = "https://api.stripe.com/v1";
const values = { name: "E-book", description: "A short guide", amount: "29.99", currency: "USD", active: true };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
afterEach(async () => { await host?.dispose(); vi.unstubAllEnvs(); });
async function setup(configured = true) {
  host = await createPluginRuntimeTestHost({ site: { url: "https://payments.test" } });
  if (configured) expect(await host.actions.plugin.updateSettings({ stripeKey: key, stripeWebhookSecret: secret })).toMatchObject({ success: true });
}
const payments = async () => (await host.inspect.storage.list<Payment>("payments")).map(r => r.data);
const customers = async () => (await host.inspect.storage.list<Customer>("customers")).map(r => r.data);
const inbox = async () => (await host.inspect.storage.list<ProviderEvent>("provider_events")).map(r => r.data);
async function queueLink(id = "plink_one") {
  await host.http.respond(`${api}/products`, response({ id: `prod_${id}`, object: "product" }));
  await host.http.respond(`${api}/prices`, response({ id: `price_${id}`, object: "price" }));
  await host.http.respond(`${api}/payment_links`, response({ id, object: "payment_link", active: true, livemode: false, url: `https://buy.stripe.com/test_${id}` }));
}
async function queueActive(id: string, active: boolean) {
  await host.http.respond(`${api}/payment_links/${id}`, response({ id, object: "payment_link", active, livemode: false }));
}
async function offer(input = values, id = "plink_one") {
  await queueLink(id);
  if (!input.active) await queueActive(id, false);
  expect((await host.admin.submit("/manage", "save_offer", input, { blockId: "new-offer" })).toast?.type).toBe("success");
  return (await host.inspect.storage.list<Offer>("offers")).at(-1)!.data;
}
async function queueState(o: Offer, checkoutId = "cs_test_one", overrides: Record<string, unknown> = {}) {
  const state = { id: checkoutId, object: "checkout.session", mode: "payment", livemode: false, status: "complete", payment_status: "paid", amount_total: o.amount, currency: o.currency,
    metadata: { plugin: "payments", site: await host.inspect.kv.get("identity:site"), offer: o.id, version: o.binding!.versionId },
    payment_link: o.binding!.id, payment_intent: { id: `pi_${checkoutId}`, object: "payment_intent", status: "succeeded" },
    customer: null, customer_details: { email: " Buyer@Example.com ", name: "Café Buyer", address: { country: "TR", line1: "NOT STORED", postal_code: "NOT STORED" } }, ...overrides };
  await host.http.respond(`${api}/checkout/sessions/${checkoutId}?expand[0]=payment_intent`, response(state));
}
async function signed(payload: string, signingSecret = secret, timestamp = Math.floor(Date.now()/1000)) {
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: signingSecret, timestamp, cryptoProvider: Stripe.createSubtleCryptoProvider() });
  return host.actions.routes.request("webhook", { method: "POST", rawBody: new TextEncoder().encode(payload), headers: { "stripe-signature": signature, "content-type": "application/json" } });
}
async function event(id = "evt_one", type: string = EVENTS[0], checkoutId = "cs_test_one") {
  return signed(JSON.stringify({ id, object: "event", type, livemode: false, data: { object: { id: checkoutId, object: "checkout.session" } } }));
}
describe("Block Kit, trusted offers, Stripe Payment Links and secrets", () => {
  it("declares exactly the runtime authority, routes and query indexes", async () => {
    await setup();
    expect(host.manifest.capabilities).toEqual(["network:request"]);
    expect(host.manifest.allowedHosts).toEqual(["api.stripe.com"]);
    expect(Object.keys(host.manifest.storage).sort()).toEqual(["customers", "offer_versions", "offers", "payments", "provider_events"]);
    expect(host.manifest.storage.payments.indexes).toEqual(["createdAt", "status", "customerId", ["customerId", "createdAt"]]);
    const webhook = host.manifest.routes.find(route => typeof route !== "string" && route.name === "webhook");
    const admin = host.manifest.routes.find(route => typeof route !== "string" && route.name === "admin");
    expect(webhook).toMatchObject({ public: true, methods: ["POST"], response: "raw", request: { body: "bytes", headers: ["stripe-signature"], maxBytes: 262144 } });
    expect(admin).toMatchObject({ permission: "plugins:manage", methods: ["POST"] });
    expect(Object.keys(host.manifest.mcp?.tools ?? {})).toHaveLength(0);
  });
  it("loads onboarding and generates a reusable hosted URL using trusted minor-unit price", async () => {
    await setup(); expect(JSON.stringify(await host.admin.loadPage("/manage"))).toContain("No payments yet");
    expect(JSON.stringify(await host.admin.act("/manage", "new"))).toContain("New offer");
    const o = await offer(); expect(o).toMatchObject({ amount: 2999, currency: "usd", provider: "stripe", schemaVersion: 1 });
    expect(o.sync).toBeUndefined();
    expect(JSON.stringify(await host.admin.act("/manage", "link", { value: o.id }))).toContain("https://buy.stripe.com/test_plink_one");
    expect(JSON.stringify(await host.admin.act("/manage", "edit", { value: o.id }))).toContain("29.99");
    const requests = host.http.requests(); expect(requests).toHaveLength(3);
    const form = new URLSearchParams(new TextDecoder().decode(requests[1].body));
    expect(form.get("unit_amount")).toBe("2999"); expect(form.get("currency")).toBe("usd");
    const link = new URLSearchParams(new TextDecoder().decode(requests[2].body));
    expect(link.get("line_items[0][quantity]")).toBe("1"); expect(link.get("line_items[0][adjustable_quantity][enabled]")).toBe("false");
    expect(link.get("metadata[offer]")).toBe(o.id); expect(link.get("metadata[version]")).toBe(o.binding!.versionId);
    expect(link.get("metadata[site]")).toBe(await host.inspect.kv.get("identity:site"));
    expect(link.get("payment_intent_data[metadata][offer]")).toBe(o.id);
    expect(link.get("customer_creation")).toBe("if_required");
    expect(link.get("after_completion[redirect][url]")).toBe("https://payments.test/_emdash/api/plugins/payments/complete");
    expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);
    expect(requests[2].headers["idempotency-key"]).toBe(`payments-${o.binding!.versionId}-link`);
    expect(await payments()).toHaveLength(0);
  });
  it.each([{ ...values, name: "" }, { ...values, amount: "1.001" }, { ...values, currency: "ZZZ" }, { ...values, active: "true" }, { ...values, provider: "other" }, { ...values, amount: 2999 }])("rejects invalid admin offers before provider calls", async input => {
    await setup(); expect((await host.admin.submit("/manage", "save_offer", input, { blockId: "new-offer" })).toast?.type).toBe("error");
    expect(await host.inspect.storage.list("offers")).toHaveLength(0); expect(host.http.requests()).toHaveLength(0);
  });
  it("sends the configured site thank-you page to Stripe without exposing secrets", async () => {
    await setup();
    expect((await host.admin.submit("/manage", "save_settings", {
      stripeKey: "", stripeWebhookSecret: "", successPath: "/payment-success",
    }, { blockId: "settings" })).toast?.type).toBe("success");
    await offer();
    const body = new URLSearchParams(new TextDecoder().decode(host.http.requests().at(-1)!.body));
    expect(body.get("after_completion[redirect][url]")).toBe("https://payments.test/payment-success");
    expect(JSON.stringify(await host.admin.act("/manage", "settings"))).not.toContain(key);
  });
  it("requires both encrypted provider credentials", async () => {
    await setup(false);
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: "new-offer" })).toast?.type).toBe("error");
    expect(await host.actions.plugin.updateSettings({ stripeKey: key })).toMatchObject({ success: true });
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: "new-offer" })).toast?.type).toBe("error");
    expect(host.http.requests()).toHaveLength(0);
  });
  it("deactivates/reactivates at Stripe without changing the hosted URL", async () => {
    await setup(); const o = await offer(); await queueActive(o.binding!.id, false);
    expect((await host.admin.submit("/manage", "save_offer", { ...values, active: false }, { blockId: o.id })).toast?.type).toBe("success");
    expect(await host.inspect.storage.get("offers", o.id)).toMatchObject({ active: false, binding: o.binding });
    const form = new URLSearchParams(new TextDecoder().decode(host.http.requests().at(-1)!.body)); expect(form.get("active")).toBe("false");
    await queueActive(o.binding!.id, true);
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: o.id })).toast?.type).toBe("success");
    expect(await host.inspect.storage.get("offers", o.id)).toMatchObject({ active: true, binding: o.binding });
  });
  it("replaces a changed price, disables the previous link and reconciles an old session", async () => {
    await setup(); const old = await offer(); await queueActive(old.binding!.id, false); await queueLink("plink_new");
    expect((await host.admin.submit("/manage", "save_offer", { ...values, amount: "39.00" }, { blockId: old.id })).toast?.type).toBe("success");
    expect(await host.inspect.storage.get("offers", old.id)).toMatchObject({ amount: 3900, binding: { id: "plink_new" } });
    expect(await host.inspect.storage.list("offer_versions")).toHaveLength(2);
    await queueState(old); expect((await event()).status).toBe(200); expect((await payments())[0].amount).toBe(2999);
  });
  it("persists uncertain offer operations and retries with the same idempotency keys", async () => {
    await setup(); await host.http.respond(`${api}/products`, response({ error: { type: "invalid_request_error", message: `private ${key}` } }, 400));
    const failed = await host.admin.submit("/manage", "save_offer", values, { blockId: "new-offer" });
    expect(failed.toast?.type).toBe("error"); expect(JSON.stringify(failed)).not.toContain(key);
    const o = (await host.inspect.storage.list<Offer>("offers"))[0].data; expect(o.sync).toBeDefined();
    expect((await host.admin.act("/manage", "link", { value: o.id })).toast?.type).toBe("error");
    expect((await host.admin.submit("/manage", "save_offer", { ...values, amount: "19.00" }, { blockId: o.id })).toast?.type).toBe("error");
    await queueLink(); expect((await host.admin.submit("/manage", "save_offer", values, { blockId: o.id })).toast?.type).toBe("success");
    expect(host.http.requests()[0].headers["idempotency-key"]).toBe(host.http.requests()[1].headers["idempotency-key"]);
    expect(await host.inspect.storage.list("offers")).toHaveLength(1);
  });
  it("blocks concurrent or stale pending offer changes and wrong credential mode", async () => {
    await setup(); const o = await offer();
    const pending = { ...o, sync: { id: crypto.randomUUID(), siteId: await host.inspect.kv.get("identity:site"), successUrl: "https://payments.test/thanks", testMode: true, recreate: false, startedAt: new Date().toISOString(), leaseUntil: new Date(Date.now()+60000).toISOString() } };
    await host.fixtures.plugin.storage("offers", o.id, pending);
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: o.id })).toast?.type).toBe("error");
    await host.fixtures.plugin.storage("offers", o.id, { ...pending, sync: { ...pending.sync, leaseUntil: new Date(0).toISOString(), startedAt: new Date(Date.now()-24*60*60*1000).toISOString() } });
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: o.id })).toast?.type).toBe("error");
    await host.fixtures.plugin.storage("offers", o.id, o); await host.actions.plugin.updateSettings({ stripeKey: "sk_live_synthetic" });
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: o.id })).toast?.type).toBe("error");
  });
  it("preserves, replaces and deliberately clears encrypted secrets without echoing them", async () => {
    await setup(); const initial = await host.inspect.settings.raw("stripeKey");
    const input = { stripeKey: "", stripeWebhookSecret: "", successPath: "/thanks" };
    expect((await host.admin.submit("/manage", "save_settings", input, { blockId: "settings" })).toast?.type).toBe("success");
    expect(await host.inspect.settings.raw("stripeKey")).toEqual(initial);
    const ui = JSON.stringify(await host.admin.act("/manage", "settings")); expect(ui).toContain("Test credentials configured"); expect(ui).not.toContain(key); expect(ui).not.toContain(secret);
    expect(JSON.stringify(initial)).not.toContain(key); expect(JSON.stringify(await host.inspect.settings.raw("stripeWebhookSecret"))).not.toContain(secret);
    expect((await host.admin.submit("/manage", "save_settings", { ...input, stripeKey: "rk_test_replacement" }, { blockId: "settings" })).toast?.type).toBe("success");
    expect(await host.inspect.settings.raw("stripeKey")).not.toEqual(initial);
    await host.admin.act("/manage", "clear_key"); expect(await host.inspect.settings.raw("stripeKey")).toBeNull();
    await host.admin.act("/manage", "clear_webhook"); expect(await host.inspect.settings.raw("stripeWebhookSecret")).toBeNull();
  });
  it.each(["//evil.example", "/%2f%2fevil.example", "/\\evil.example"])("rejects unsafe settings before writing secrets", async path => {
    await setup(); const initial = await host.inspect.settings.raw("stripeKey");
    expect((await host.admin.submit("/manage", "save_settings", { stripeKey: "sk_test_replacement", successPath: path }, { blockId: "settings" })).toast?.type).toBe("error");
    expect(await host.inspect.settings.raw("stripeKey")).toEqual(initial);
  });
  it("tests API access and enforces admin permission/CSRF", async () => {
    await setup(); await host.http.respond(`${api}/balance`, response({ object: "balance", available: [], pending: [] }));
    expect((await host.admin.act("/manage", "test_connection")).toast?.type).toBe("success");
    const editor = await host.fixtures.user({ email: "editor@example.com", role: "editor" });
    expect((await host.actions.routes.request("admin", { method: "POST", body: { type: "page_load", page: "/manage" }, user: editor, headers: { "X-EmDash-Request": "1" } })).status).toBe(403);
    expect((await host.actions.routes.request("admin", { method: "POST", body: {} })).status).toBe(401);
    const admin = await host.fixtures.user({ email: "admin@example.com", role: "admin" });
    expect((await host.actions.routes.request("admin", { method: "POST", body: {}, user: admin })).status).toBe(403);
    expect((await host.admin.submit("/manage", "save_offer", values, { blockId: "bad" })).toast?.type).toBe("error");
  });
  it("exposes no financial mutation route to visitors and never trusts success redirects", async () => {
    await setup(); await offer();
    for (const route of ["complete", "canceled"]) {
      const r = await host.actions.routes.request(route, { method: "GET", url: "https://payments.test/?status=succeeded&payment=x" });
      expect(r.status).toBe(200); const body = await r.text(); expect(body).not.toContain(key); expect(body).not.toContain(secret); expect(body).not.toContain("buyer@example.com");
    }
    expect(await payments()).toHaveLength(0); expect(await customers()).toHaveLength(0);
    expect((await host.actions.routes.request("checkout", { method: "POST", body: { amount: 1 } })).status).not.toBe(200);
  });
});
describe("verified events, atomic deduplication and normalized customer/payment records", () => {
  it("preserves noncanonical UTF-8 bytes, verifies signatures and stores minimal normalized records", async () => {
    await setup(); const o = await offer(); await queueState(o);
    const payload = '{\n "id": "evt_utf8", "type": "checkout.session.completed", "livemode": false, "data": {"object": {"object": "checkout.session", "id": "cs_test_one", "name": "Café"}}\n}';
    expect((await signed(payload)).status).toBe(200);
    expect(await payments()).toHaveLength(1); const p = (await payments())[0]; expect(p).toMatchObject({ status: "succeeded", providerEventId: "evt_utf8", amount: 2999, currency: "usd", schemaVersion: 1 });
    const c = (await customers())[0]; expect(c).toMatchObject({ email: "buyer@example.com", name: "Café Buyer", country: "TR", schemaVersion: 1 }); expect(p.customerId).toBe(c.id);
    expect(JSON.stringify(await customers())).not.toContain("NOT STORED");
    expect((await inbox())[0]).toMatchObject({ status: "processed", providerEventId: "evt_utf8", attempts: 1 }); expect(Object.keys((await inbox())[0])).not.toContain("payload");
    await host.admin.act("/manage", "payments"); await host.admin.act("/manage", "offers"); await host.admin.act("/manage", "customers"); await host.admin.act("/manage", "purchases", { value: c.id }); await host.admin.act("/manage", "settings");
  });
  it("rejects missing/invalid/stale signatures, altered bytes and malformed JSON before writes", async () => {
    await setup();
    expect((await signed("{}", "whsec_wrong")).status).toBe(400); expect((await signed("{}", secret, Math.floor(Date.now()/1000)-600)).status).toBe(400);
    expect((await signed("{broken")).status).toBe(400); expect((await signed('{"id":"evt_x"}')).status).toBe(400);
    expect((await host.actions.routes.request("webhook", { method: "POST", rawBody: "{}" })).status).toBe(400);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: "{}", secret, cryptoProvider: Stripe.createSubtleCryptoProvider() });
    expect((await host.actions.routes.request("webhook", { method: "POST", rawBody: "{ }", headers: { "stripe-signature": signature } })).status).toBe(400);
    expect(await inbox()).toHaveLength(0); expect(await customers()).toHaveLength(0); expect(host.http.requests()).toHaveLength(0);
    expect((await host.actions.routes.request("webhook", { method: "GET" })).status).toBe(405);
  });
  it("ignores duplicate delivery without provider requests or duplicate payments/customers", async () => {
    await setup(); const o = await offer(); await queueState(o); expect((await event()).status).toBe(200); expect((await event()).status).toBe(200);
    expect(await payments()).toHaveLength(1); expect(await customers()).toHaveLength(1); expect(await inbox()).toHaveLength(1); expect(host.http.requests()).toHaveLength(4);
  });
  it("handles concurrent event delivery and retries without duplicates", async () => {
    await setup(); const o = await offer(); await queueState(o);
    const results = await Promise.all([event(), event()]); expect(results.some(r => r.status === 200)).toBe(true); expect(results.every(r => [200, 503].includes(r.status))).toBe(true);
    expect((await event()).status).toBe(200); expect(await payments()).toHaveLength(1); expect(await customers()).toHaveLength(1);
  });
  it("deduplicates separate events for one session and repeated guest purchases", async () => {
    await setup(); const o = await offer();
    for (let i = 0; i < 4; i++) { await queueState(o, `cs_test_${i}`, i < 2 ? {} : { customer: `cus_distinct${i}` }); expect((await event(`evt_${i}`, EVENTS[0], `cs_test_${i}`)).status).toBe(200); }
    await queueState(o, "cs_test_0"); expect((await event("evt_separate", EVENTS[1], "cs_test_0")).status).toBe(200);
    expect(await payments()).toHaveLength(4); expect(await customers()).toHaveLength(3);
  });
  it("handles delayed payment failure and success without false success", async () => {
    await setup(); const o = await offer(); await queueState(o, "cs_test_one", { payment_status: "unpaid", payment_intent: { id: "pi_delayed", status: "processing" } });
    expect((await event()).status).toBe(200); expect((await payments())[0].status).toBe("pending"); expect(await customers()).toHaveLength(0);
    await host.actions.routes.request("complete", { method: "GET", url: "https://payments.test/?status=succeeded" });
    expect((await payments())[0].status).toBe("pending");
    await queueState(o, "cs_test_one", { payment_status: "unpaid", payment_intent: { id: "pi_delayed", status: "requires_payment_method", last_payment_error: { code: "failed" } } });
    expect((await event("evt_failed", EVENTS[2])).status).toBe(200); expect((await payments())[0].status).toBe("failed");
    await queueState(o, "cs_test_one", { payment_intent: { id: "pi_delayed", status: "succeeded" } });
    expect((await event("evt_paid", EVENTS[1])).status).toBe(200); expect((await payments())[0].status).toBe("succeeded");
  });
  it("records expiration and prevents out-of-order success downgrades", async () => {
    await setup(); const o = await offer(); await queueState(o); expect((await event()).status).toBe(200);
    await queueState(o, "cs_test_one", { status: "expired", payment_status: "unpaid", customer_details: null });
    expect((await event("evt_late", EVENTS[3])).status).toBe(200); expect((await payments())[0].status).toBe("succeeded");
    await queueState(o, "cs_test_expired", { status: "expired", payment_status: "unpaid", payment_intent: null });
    expect((await event("evt_expired", EVENTS[3], "cs_test_expired")).status).toBe(200);
    expect((await payments()).find(p => p.providerCheckoutId === "cs_test_expired")!.status).toBe("canceled");
  });
  it.each([{ amount_total: 1 }, { currency: "eur" }, { livemode: true }, { payment_link: "plink_other" }])("rejects state that does not match the server offer snapshot", async overrides => {
    await setup(); const o = await offer(); await queueState(o, "cs_test_one", overrides);
    expect((await event()).status).toBe(503); expect(await payments()).toHaveLength(0); expect(await customers()).toHaveLength(0); expect((await inbox())[0]).toMatchObject({ status: "failed", diagnostic: "reconciliation_failed" });
  });
  it("retries failed reconciliation with a persisted event checkpoint", async () => {
    await setup(); const o = await offer(); await host.http.respond(`${api}/checkout/sessions/cs_test_one?expand[0]=payment_intent`, response({ error: { type: "api_error", message: "transient" } }, 500));
    expect((await event()).status).toBe(503); await queueState(o); expect((await event()).status).toBe(200); expect((await inbox())[0]).toMatchObject({ status: "processed", attempts: 2 }); expect(await customers()).toHaveLength(1);
  });
  it("ignores unrelated verified events and other-site checkouts", async () => {
    await setup(); expect((await signed(JSON.stringify({ id: "evt_unrelated", type: "customer.created", livemode: false, data: { object: { object: "customer", id: "cus_x" } } }))).status).toBe(200);
    const o = await offer(); await queueState(o, "cs_test_one", { metadata: { plugin: "payments", site: "other", offer: o.id, version: o.binding!.versionId } });
    expect((await event()).status).toBe(200); expect(await payments()).toHaveLength(0); expect((await inbox()).every(e => e.status === "ignored")).toBe(true);
  });
  it("keeps records and deduplication across restart", async () => {
    await setup(); const o = await offer(); await queueState(o); expect((await event()).status).toBe(200); await host.restart(); expect((await event()).status).toBe(200); expect(await payments()).toHaveLength(1); expect(await customers()).toHaveLength(1);
  });
  it("recovers an expired processing lease without duplicate records", async () => {
    await setup(); const o = await offer();
    await host.fixtures.plugin.storage("provider_events", "stripe_test_evt_one", { provider: "stripe", providerEventId: "evt_one", type: EVENTS[0], testMode: true, receivedAt: new Date().toISOString(), status: "processing", leaseUntil: new Date(0).toISOString(), attempts: 1, schemaVersion: 1 });
    await queueState(o); expect((await event()).status).toBe(200); expect((await inbox())[0]).toMatchObject({ status: "processed", attempts: 2 }); expect(await payments()).toHaveLength(1); expect(await customers()).toHaveLength(1);
  });
});
