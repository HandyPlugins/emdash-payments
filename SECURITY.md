# Security

Report suspected vulnerabilities privately to **support@handyplugins.co**.
Include Payments and EmDash versions and synthetic reproduction steps. Never
send API keys, signing secrets, card details, real customer data or raw logs.

Payments runs inside EmDash's sandbox. Its only additional capability is
HTTPS access to `api.stripe.com`. Credentials are EmDash encrypted secret
settings using AES-GCM, random nonces and authenticated plugin/setting identity;
keep the site's encryption keys with secure operational backups. Secret inputs
are masked and normal admin blocks never echo credentials. Database verification
confirmed encrypted envelopes for both configured Stripe secrets.

Public webhook requests use exact bytes, an explicitly forwarded
`stripe-signature` header, the endpoint's signing secret and Stripe's official
async verification with a five-minute timestamp tolerance. Nothing is parsed or
stored before verification. Verified events are claimed atomically and retried
after failed processing or an expired lease. Stripe state is retrieved before
reconciliation and compared with immutable server-created offer snapshots.

Payment and customer writes are separate atomic operations, not one transaction.
Deterministic keys and bounded compare-and-set retries make interrupted replay
converge without duplicate payments/customers. Successful payments are terminal
in this release; refunds are not synchronized. Never use a success page as
proof of payment or grant access from an email address alone.

Only site administrators can access local payment/customer information. No
financial operations are exposed through MCP. This package stores no cards,
CVCs, full billing addresses, payment-method details or raw webhook payloads.
Basic customer email/name/country and payment history use regular plugin storage,
without additional field encryption. Protect the database and backups with
appropriate filesystem access and storage encryption; secret-setting encryption
does not encrypt the entire database.

Deleting credentials does not deactivate existing Stripe-hosted links. Disable
links before removing credentials, or disable them directly in Stripe. Do not
change Stripe accounts while an offer update is unresolved. API-side object
creation can succeed even if a response is lost: pending updates retain their
idempotency keys and stop automatic replay after 23 hours. Older uncertain
updates require inspecting Stripe request logs before manual recovery.
