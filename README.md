# Payments

Accept payments on your EmDash site without a full commerce platform.

A sandboxed HandyPlugins plugin, **0.1.1 release candidate**, prepared for
`@handyplugins.co/payments`. Requires **EmDash >=1.2.0 <2.0.0**.
Stripe is the only provider. This release supports fixed-price, one-time hosted
payments, quantity 1, reusable offers, payment history and basic customer records.
It is not a cart, order fulfillment service, membership system, CRM or accounting
ledger. There are no subscriptions, refunds, coupons, tax calculation, downloads,
license keys, payment-changing MCP tools or Pro functionality.

## Setup

1. Install Payments, review network/public-route permissions, and open Payments.
2. Open **Settings** and save a Stripe secret or restricted API key and the
   endpoint-specific webhook signing secret. Start with test/sandbox credentials.
3. In Stripe's event destinations, add the HTTPS **POST** endpoint displayed in
   Settings. The URL contains the installation's runtime ID, which may differ
   from `payments` when installed from the registry. Copy it exactly.
4. Subscribe only to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, and `checkout.session.expired`.
5. Open **Offers → Add offer**, enter the name, optional description, amount,
   three-letter ISO currency and active status. Save and copy the hosted URL.
6. Add that URL to a normal button or link on your site. Confirm a test payment,
   webhook delivery, payment history and customer record before accepting money.

Empty secret inputs preserve existing credentials. Replacing a secret is
deliberate; confirmed **Clear** buttons remove it. Existing secrets are never
returned to the browser. EmDash encrypts them using its `secret` settings schema,
not plugin storage or KV. Back up the complete `EMDASH_ENCRYPTION_KEY` rotation
list separately with your operational secrets. A database alone cannot recover
encrypted credentials.

Use a restricted key where practical with **Products write**, **Prices write**,
**Payment Links write**, **Checkout Sessions read**, and **Payment Intents read**
for expanded state. Optional **Balance read** permits Test connection. Check
Stripe's current permission UI and test the entire workflow: Test connection
only checks balance access, not all permissions or webhook delivery. No account,
customer, refund or subscription write authority is needed. Never enter a
publishable `pk_` key. Key prefixes determine test/live mode; the UI shows only
that classification. Create separate offers for different modes. Keep the same
Stripe account while resolving an interrupted offer save; key rotation within
that account is supported. Only one credential set is active. Switching modes
prevents reconciliation of unfinished checkouts from the previous mode; settle
or expire them before switching, or use separate sites for simultaneous modes.

## Hosted checkout and offer editing

Stripe **Payment Links** open Stripe-hosted Checkout. The plugin creates one
Product, one fixed Price and one Payment Link from administrator-validated
server data. Buyers supply no trusted amount, currency, Price ID or ownership
metadata to an EmDash route. No card collection code or public financial mutation
route runs on the site. Adjustable quantities, promotion codes and automatic tax
are disabled. Other payment-method and currency availability remains subject to
Stripe account/country rules.

The copied `https://buy.stripe.com/...` URL is reusable and does not expire like
a Checkout Session. Activation/deactivation preserves it and is synchronized at
Stripe. Product or price edits create a replacement link and disable the previous
one; **update any site buttons after such an edit**. Stripe's current update API
does not replace a link's price. Sessions already opened before a change can
still finish at their original price, and immutable offer snapshots allow those
payments to reconcile correctly. Do not independently edit these links/prices,
add tax, discounts or optional items in Stripe; mismatched totals fail closed.

Payment Links are the appropriate sandbox-compatible surface here. EmDash 1.2.0
preserves raw byte webhook bodies and safe declared headers, but public raw
redirects must stay on the site's origin and raw HTML/JavaScript is prohibited.
An EmDash route cannot securely act as a direct Stripe Checkout redirect without
additional native/frontend code. Payment Links avoid those requirements and
leave checkout creation at Stripe.

Offer updates are atomically claimed. Interrupted updates retain their original
payload and idempotency keys. Open the pending offer, save its unchanged values
and retry after the lease expires. After 23 hours, inspect Stripe request logs
and contact support before manual recovery: Stripe may prune idempotency keys
after 24 hours. Objects created before a failed later step may remain in Stripe;
the plugin does not delete financial/provider history. A pending save may have
deactivated the previous link. Removing credentials does not disable hosted
links—deactivate offers first or disable links in Stripe.

## Money and return behavior

Amounts are parsed as decimal strings with integer/BigInt operations and stored
as safe integer minor units; binary floating-point arithmetic is never used to
calculate prices. Currency validation uses the runtime's maintained ISO data,
with Stripe's zero-decimal and ISK/UGX compatibility rules. ISK and UGX require
whole units represented in Stripe's two-decimal API format. Three-decimal
currencies use their ISO exponent. The local maximum is 99,999,999 minor units;
Stripe enforces account-specific minimums and availability. This is generic ISO
validation, not a claim that every ISO currency is supported by every account.

The success destination defaults to the installation's public plain-text
acknowledgement at `/_emdash/api/plugins/<runtime-id>/complete`. A previously
saved 0.1.0 default is resolved to the current runtime ID automatically.
Set a same-site path such as `/payment-success` in Settings before creating
links. It applies to newly created links; existing
links keep their configured destination. Absolute URLs, double slashes,
backslashes, escapes and unsafe paths are rejected. Cancellation/back behavior
is controlled by Stripe's hosted Payment Link checkout; there is no configurable
cancel URL in this release. The optional public `/canceled` acknowledgement never
changes payment state. A success return **never confirms payment**.

### A welcoming thank-you page

The source repository includes a responsive, server-rendered Astro example
that uses the Node Starter's existing site layout, a thank-you card, a brief
explanation of payment confirmation, and a link back to the website. It loads
no browser JavaScript or third-party assets and does not expose customer data.

1. Copy `examples/CheckoutThanks.astro` to your site's
   `src/components/CheckoutThanks.astro`.
2. Copy `examples/payment-success.astro` to `src/pages/payment-success.astro`.
   It imports the starter's `src/layouts/Base.astro`; adapt that import if your
   site uses another layout.
3. Confirm `/payment-success` renders, then save `/payment-success` under
   Payments → Settings → Success destination before creating hosted links.

The page is read-only and uses `no-store`, `noindex, nofollow`, and
`no-referrer` response headers. It does not promise fulfillment, email or
confirmed payment before verified provider reconciliation. Sandboxed EmDash
API routes deliberately cannot serve HTML, so this page belongs to the site
layer and requires no additional plugin capabilities.

When upgrading a registry installation from 0.1.0, replace Stripe's old webhook
URL with the exact URL displayed in Settings. Existing hosted links keep their
old return URL; replace affected offers' links after configuring a working
destination. Product/price edits create a replacement and deactivate the old
link, as described above.

## Webhooks and records

Stripe remains the payment authority. The plugin verifies exact raw bytes using
the official SDK's `constructEventAsync`, Web Crypto, the endpoint secret and a
300-second timestamp tolerance. Invalid signatures/payloads return **400** without
storage writes. Successfully processed, duplicate and unrelated verified events
return **200**. Temporary/configuration/reconciliation failures return **503** so
Stripe retries. Requests are capped at 256 KiB. Only the declared signature
header enters the sandbox.

Each recognized event retrieves the current Checkout Session with expanded
PaymentIntent, checks site/offer/version/Payment Link/mode/amount/currency against
the saved snapshot, then reconciles. Separate event IDs for one Session converge
on one deterministic local payment ID. Event IDs are durable deduplication keys;
timestamps never determine uniqueness or delivery ordering. A 60-second atomic
lease prevents concurrent event processing; failed or expired claims can retry.
Bounded per-record compare-and-set retries preserve success against late events.
No queue is introduced: processing performs one bounded provider read and a few
storage operations, without fulfillment or lengthy background work.

Statuses are `pending`, `succeeded`, `failed`, and `canceled`. Unpaid completed
sessions remain pending until Stripe confirms a delayed result. Failed delayed
payments come from current PaymentIntent state; expired sessions become canceled.
Card declines that remain inside an open Checkout Session do not necessarily
produce a completed-payment event; Stripe's dashboard remains authoritative for
those attempts. Records appear after a verified subscribed webhook, not on every
visit to a hosted link. Refunds are intentionally not synchronized: succeeded
does not mean net proceeds after refunds, disputes or fees.

Local **customers** store an opaque ID, provider, optional provider Customer ID,
normalized email, name, two-letter country, test/live mode, timestamps and schema
version. Guest Checkout uses `customer_creation=if_required`; a persistent Stripe
Customer is not forced. Exact provider Customer ID is strongest; otherwise guest
purchases group by exact trimmed/lowercased email within mode. Distinct provider
Customer IDs never merge just because emails match; there is no fuzzy matching
or authentication based on purchase email. Missing identity uses the payment ID.

Local **payments** store an opaque ID, provider checkout/payment/event IDs, offer
ID and name snapshot, customer association, integer amount/currency, normalized
status, mode, timestamps and schema version. **Provider events** retain ID/type,
mode, received/processed timestamps, status, attempts, lease and a fixed safe
diagnostic code. No raw events, card numbers, CVC, payment-method secrets, full
billing addresses or unnecessary billing/tax data are stored. Those remain in
Stripe. Both site-admin routes and UI restrict payment/customer access to admins.
Data is retained until removed through site administration/backups; v0.1 has no
customer erasure/export UI or event retention scheduler. Plan your retention
policy before production deployment.

## Architecture and capabilities

`domain/` owns offers, exact money, customers and normalized reconciliation;
`providers/types.ts` defines only create-offer-link, set-link-active, read-checkout,
verify-webhook and connection-check operations; `providers/stripe.ts` contains
SDK objects and provider normalization. `storage.ts`, `settings.ts`, `admin.ts`
and the route entry remain small. Future providers can implement this boundary
without reshaping the core as Stripe objects. There is no Automations dependency
or invented cross-plugin event bus. EmDash currently exposes built-in lifecycle
hooks, not a portable custom financial event contract; future integration needs
an official supported mechanism.

Only **`network:request`**, restricted to **`api.stripe.com`**, is requested. Site
content/users/media/email authority and unrestricted networking are unnecessary.
Settings, KV, logging and declared structured storage are plugin-scoped defaults.
The public surface is the signature-authenticated webhook and read-only return
acknowledgements; no MCP tools are declared. Admin is a POST-only private
`plugins:manage` route with host authentication/CSRF plus an admin-role guard.

| Collection | Indexes and purpose |
| --- | --- |
| `offers` | `createdAt`: paginated administrator list; contains link binding and pending save state |
| `offer_versions` | None: immutable price/ownership snapshots read directly by version ID |
| `customers` | `createdAt`: paginated list; deterministic customer IDs provide direct matching |
| `payments` | `createdAt`, `status`, `customerId`, `[customerId, createdAt]`: list, count and purchase history |
| `provider_events` | `receivedAt`: recent operational events; event-ID-derived keys deduplicate directly |

All durable records have schema version 1. KV holds only a generated site identity,
never secrets. Admin navigation uses four compact views: **Payments**, **Offers**,
**Customers** and **Settings**, with 30-record cursor pages and useful empty states.

## Development and verification

This is an independent package, not a pnpm monorepo. Use **Node 24.21.0** and
**pnpm 11.9.0**. From this repository, run:

```bash
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm validate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bundle
```

The optional development lab connects this package to a separate Node Starter.
From that lab's root, select the same pinned runtime and its local Corepack
cache as documented in the lab README, then:

```bash
corepack pnpm --dir payments install --frozen-lockfile
corepack pnpm --dir payments validate
corepack pnpm --dir payments typecheck
corepack pnpm --dir payments test
corepack pnpm --dir payments build
corepack pnpm dev:payments
# In another terminal:
corepack pnpm dev
```

Open `http://localhost:4321/_emdash/admin/plugins/payments/manage`. The playground
links the generated descriptor alongside Tables, Automations and Import, preserving
workerd isolation and the official Starter. Existing plugins remain enabled.

Stripe **23.0.0** uses its `2026-09-30.endive` API version, Fetch transport through
`ctx.http.fetch`, async Web Crypto signatures and disabled telemetry. The scoped
pnpm CLI patch bundles Stripe with the `workerd` export condition, prevents Node
built-in imports, fixes the lab's existing Chokidar directory-watch issue, and
includes license/security/third-party notice files in the registry bundle.
The stock CLI externalizes Stripe; the patch is necessary for a self-contained
sandbox artifact and must be reviewed on CLI upgrades. The full SDK exceeds
the registry's 128 KiB backend limit. A separate, version-pinned Stripe patch
limits the ESM resource registry to Products create, Prices create, Payment Links
create/update, Checkout Sessions retrieve and Balance retrieve. The retained
upstream methods, transport, retries, API version and webhook verification are
unchanged. Unused API groups and methods are unavailable in
this plugin's runtime. Zod Mini preserves input validation with a smaller bundle.
Review both patches and rerun the complete suite before upgrading. SDK MIT attribution is
included in `THIRD-PARTY-NOTICES.md`. Both API transport and signature
verification are tested through Worker Loader and the production host bridge;
the actual playground tests the Node/workerd runner too.

Automated tests use synthetic encryption keys, Stripe's official signing utility,
mocked provider responses and the official runtime host. No live Stripe credentials
are required. To verify real payments locally, save Stripe sandbox credentials
through Settings and run `stripe listen --forward-to
localhost:4321/_emdash/api/plugins/payments/webhook` with the four listed events.
Save the CLI listener's own signing secret (not a dashboard endpoint secret),
create an offer, open its hosted link, complete a Stripe test payment, and verify
the local records and Stripe delivery response. Never commit credentials. For a
deployed site, use an HTTPS endpoint and its dashboard-specific secret.

## References

- [Stripe Payment Links API](https://docs.stripe.com/payment-links/api)
- [Create Payment Link](https://docs.stripe.com/api/payment-link/create)
- [Update Payment Link](https://docs.stripe.com/api/payment-link/update)
- [Checkout fulfillment and delayed payments](https://docs.stripe.com/payments/checkout/fulfill-orders)
- [Stripe webhook verification/retries](https://docs.stripe.com/webhooks)
- [Stripe currency rules](https://docs.stripe.com/currencies)
- [Official Stripe JavaScript SDK](https://github.com/stripe/stripe-node)
- [EmDash routes](https://docs.emdashcms.com/plugins/creating-plugins/api-routes/)
- [EmDash encrypted settings](https://docs.emdashcms.com/plugins/creating-plugins/settings/)
- [EmDash structured storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/)

## Release

Package metadata uses the established HandyPlugins publisher DID and MIT license.
The expected source repository is `https://github.com/HandyPlugins/emdash-payments`;
its public existence was confirmed during release verification. The 0.1.1
candidate passed manifest validation, TypeScript, 69 automated tests across
three files, build and bundle checks. Its runtime-ID fix was verified in a
separate EmDash site under a different installation ID. A real Stripe sandbox
checkout verified a 1.00 USD succeeded payment,
customer history, signed HTTP 200 delivery, duplicate redelivery without duplicate
records, stable activation URLs and replacement URLs after repricing.

API and webhook credentials use EmDash AES-GCM encrypted secret settings;
actual persisted envelopes were verified without disclosing their contents.
Card details, CVCs, full addresses and raw webhook payloads are never retained.
Basic customer identity and purchase records use administrator-only plugin
storage, without additional field encryption. See SECURITY.md for operational
requirements and IMPLEMENTATION.md in the development checkout for verification
details. Version 0.1.0 is published; 0.1.1 is prepared for review and requires
the user's explicit registry publication approval.
