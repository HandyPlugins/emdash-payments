# Runtime dependency patches

These patches apply only to this independent package and are reproduced by its
lockfile. Review them against upstream before changing dependency versions.

## Plugin CLI 0.13.3

- Select Stripe's `workerd` conditional export for both probing and runtime builds.
- Bundle `stripe` and `zod/mini` instead of leaving unresolved external imports.
- Include LICENSE, SECURITY.md and THIRD-PARTY-NOTICES.md in registry tarballs.
- Watch the `src` directory recursively; Chokidar 5 no longer accepts `src/**`.

No registry size limits or sandbox checks are modified.

## Stripe 23.0.0

The complete official SDK exceeded EmDash's 128 KiB backend limit. The ESM
entry retains only these official resource methods:

| Resource | Retained methods |
| --- | --- |
| Products | create |
| Prices | create |
| Payment Links | create, update |
| Checkout Sessions | retrieve |
| Balance | retrieve |

The resource registry and unused methods are trimmed. Retained method bodies,
request encoding, response schemas, Fetch transport, Web Crypto, webhook
signature verification, timestamp tolerance and API version remain upstream.
Node's CJS entry is unmodified; tests use its official event-signing utility.
This runtime is intentionally a subset of the SDK despite its complete type
declarations. Do not call another resource without updating this patch.

Use Zod Mini for functional validation so the official payment SDK fits inside
the unchanged registry limits. After any dependency or patch change, run
validate, typecheck, test, build and bundle, and check the archive's file sizes,
not only the source descriptor. Never raise limits to make the SDK fit.
