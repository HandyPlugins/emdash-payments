import { pluginRoute, pluginResponse, type SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./admin.js";
import { processEvent } from "./domain/webhooks.js";
import { stripeProvider } from "./providers/stripe.js";
const text = (status: number, value: string, headers: Record<string, string> = {}) => pluginResponse({ status, headers: { "content-type": "text/plain; charset=utf-8", ...headers }, body: { kind: "text", value } });
const plugin: SandboxedPlugin = {
  routes: {
    admin: { permission: "plugins:manage", methods: ["POST"], request: { body: "json", maxBytes: 16 * 1024 }, handler: handleAdmin },
    webhook: pluginRoute({ public: true, methods: ["POST"], request: { body: "bytes", headers: ["stripe-signature"], maxBytes: 256 * 1024 }, response: "raw", handler: async (route, ctx) => {
      let provider;
      let secret;
      try { provider = await stripeProvider(ctx); secret = await ctx.settings.get<string>("stripeWebhookSecret"); }
      catch { return text(503, "Webhook is not configured."); }
      if (!secret) return text(503, "Webhook is not configured.");
      let event;
      try { event = await provider.verifyWebhook(route.input, route.request.headers["stripe-signature"] ?? "", secret); }
      catch { return text(400, "Invalid webhook signature or payload."); }
      try { await processEvent(ctx, provider, event); return text(200, "Received."); }
      catch { ctx.log.warn("Payment could not be reconciled", { providerEventId: event.id }); return text(503, "Payment could not be reconciled. Retry delivery."); }
    } }),
    complete: pluginRoute({ public: true, methods: ["GET"], request: { body: "none" }, response: "raw", cacheControl: "no-store", handler: async () => text(200, "Thank you. Your checkout has returned from Stripe. Payment confirmation may still be processing; this page is not proof of payment.") }),
    canceled: pluginRoute({ public: true, methods: ["GET"], request: { body: "none" }, response: "raw", cacheControl: "no-store", handler: async () => text(200, "You left checkout. No payment status has been changed by this page. You can return to the offer to try again.") }),
  },
};
export default plugin;
