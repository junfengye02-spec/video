# NewAPI Same-Route Usage Quote Design

**Status:** Approved on 2026-07-10

**Supersedes:** The OpenMontage-side model estimator described by the billing design and implementation plan. Final receipt settlement remains unchanged.

## Problem

OpenMontage must freeze wallet credit before a paid provider call, but it must not maintain a second copy of NewAPI model prices, token rules, channel mappings, duration factors, resolution factors, tiered expressions, or adapter-specific billing behavior. Those rules already change inside NewAPI as models and providers evolve.

NewAPI already has the two authoritative billing stages:

- Synchronous relay requests use request validation, token counting, `ModelPriceHelper`, and `PreConsumeBilling` before the upstream call.
- Asynchronous task requests select a channel and task adapter, validate the request, call adapter `EstimateBilling`, apply `OtherRatios`, and call `PreConsumeBilling` before submitting upstream.
- Both paths settle or refund after the provider result, and the token-scoped receipt endpoints expose the final request/task cost.

The missing contract is a safe way for OpenMontage to ask NewAPI for that exact pre-consume result before OpenMontage creates its own wallet hold.

## Decision

Add a quote-only mode to the real NewAPI relay endpoints. A quote request traverses the same authentication, channel distribution, request parsing, token counting, model pricing, tiered expression, and adapter estimate path as the real request. It stops before NewAPI pre-consumes quota and before any upstream network call.

OpenMontage uses the quote only to size its wallet hold. It always uses the final token-scoped receipt for the wallet charge.

## Alternatives Considered

### Separate Generic Estimate Endpoint

A standalone `/api/usage/estimate` endpoint would need to recreate relay formats, channel selection, image count behavior, task adapter parsing, and tiered billing inputs. That duplicate path would drift as NewAPI adds models and adapters. Rejected.

### OpenMontage Pricing Tables

OpenMontage could maintain model profiles and price multipliers. This would require deployments for every NewAPI pricing or adapter change and could under-reserve a request. Rejected.

### Receipt-Only Post-Charge

OpenMontage could invoke first and debit only after the final receipt. Concurrent calls could exceed the user's available balance and transfer provider loss to the operator. Rejected because the wallet hold remains required.

## Protocol

### Quote-Only Request

OpenMontage sends the exact request to the exact relay endpoint it intends to call and adds:

```http
X-OneAPI-Quote-Only: 1
```

The request uses the same ordinary OpenMontage token that will make the real call. Existing `TokenAuth`, model allowlist checks, fixed token group, request validation, rate limits, and `Distribute` middleware still apply.

NewAPI returns HTTP 200 without pre-consuming quota, creating a consume log, or contacting the upstream provider:

```json
{
  "quote_id": "uq_01J...",
  "status": "quoted",
  "model": "provider-model",
  "fixed_group": "openmontage-video",
  "relay_format": "task",
  "estimated_quota": 1449000,
  "quota_per_unit": 500000,
  "cost_currency": "USD",
  "estimated_cost_amount_micro": 2898000,
  "pricing_version": "sha256:...",
  "billing_fingerprint": "sha256:...",
  "other_ratios": {
    "seconds": 10,
    "resolution": 1
  },
  "expires_at": 1783390000
}
```

The response never includes a token key, upstream key, user identity, channel ID, channel key, pricing expression, prompt, request body, or another token's data.

### Real Request

OpenMontage sends the same logical request to the same endpoint and adds:

```http
X-OneAPI-Usage-Quote: uq_01J...
```

NewAPI loads the quote by quote ID and authenticated token ID, forces the quoted channel, reruns the same billing preparation, and validates all of the following before pre-consume or upstream I/O:

- quote state is `quoted` and not expired;
- token ID, fixed group, HTTP method, route family, relay format, model, and selected channel match;
- `quota_per_unit` and `pricing_version` match;
- the normalized billing fingerprint matches;
- the recomputed pre-consume quota equals the quoted quota.

Any mismatch returns HTTP 409 with code `quote_stale`. NewAPI does not pre-consume and does not contact the upstream provider. OpenMontage obtains a fresh quote and resizes the existing job hold before retrying.

### Billing Fingerprint

The fingerprint is produced from normalized billing determinants, not raw prompt text or uploaded media:

- authenticated token ID and fixed group;
- route family, relay format, model, and quoted channel;
- estimated prompt tokens and maximum output tokens for text;
- validated count, size, quality, duration, resolution, and adapter `OtherRatios` when present;
- model price/ratio, completion ratio, group ratio, tiered billing snapshot hash, quota-per-unit, pricing version, and final pre-consume quota.

NewAPI serializes this structure with `common.Marshal`, hashes it with SHA-256, and stores only the hash and normalized quote metadata. It never stores the prompt, request body, uploaded media, token key, or upstream key in the quote row.

## NewAPI Quote State

NewAPI persists quotes in its primary database so the flow works across process restarts and multiple instances. The GORM model and migration must support SQLite, MySQL, and PostgreSQL.

`usage_quotes` stores:

- opaque random `quote_id` primary key;
- authenticated `token_id` and fixed group;
- method, route family, relay format, model, and internal selected channel ID;
- estimated quota, canonical decimal quota-per-unit snapshot, integer estimated micro-USD, pricing version, and canonical `OtherRatios` JSON;
- billing fingerprint;
- state `quoted|consuming|accepted|failed|expired`;
- local NewAPI request ID and optional provider reference type/ID;
- created, expiry, consumed, and updated timestamps.

Quote execution lifetime is 120 seconds. Expired quotes cannot be used. `USAGE_QUOTE_RETENTION_SECONDS` defaults to `604800` (7 days) and controls cleanup. Cleanup first persists expired `quoted` rows as `expired`, deletes terminal/expired rows older than retention, and may delete an indeterminate `consuming` row only after its consumption timestamp is older than retention; it never converts `consuming` to replay-permitting `failed`. `USAGE_QUOTE_REFERENCE_RECOVERY_SECONDS` defaults to `86400`, is deployed with the same value as OpenMontage `BILLING_REFERENCE_RECOVERY_SECONDS`, and lets NewAPI reject startup unless retention is greater than both execution lifetime and reference recovery.

## One-Time Consumption And Recovery

The real request atomically changes the quote from `quoted` to `consuming` before NewAPI pre-consume or upstream I/O. A second request cannot consume the same quote.

NewAPI records its local request ID before upstream I/O. For task relays, it also records the public task ID as soon as that ID is generated. After upstream acceptance it marks the quote `accepted` and stores the request/task reference. A pre-acceptance failure marks it `failed`.

The historical token-scoped endpoint:

```text
GET /api/usage/quote/{quote_id}
```

returns quote state and its request/task reference. It uses the same retained-token historical authentication as receipt lookup. Another token receives 404. This lets OpenMontage recover a reference after a network timeout or process crash without exposing provider data.

The external response uses `status`, while the database column may use `state`:

```json
{
  "quote_id": "uq_01J...",
  "status": "accepted",
  "reference_type": "task",
  "reference_id": "task_01J...",
  "created_at": 1783389880,
  "expires_at": 1783390000,
  "consumed_at": 1783389900,
  "updated_at": 1783389902
}
```

## Relay Integration

### Synchronous Text And Image

The quote-only branch runs through `GetAndValidateRequest`, `GenRelayInfo`, token estimation, and `ModelPriceHelper`. Known request multipliers must be applied before both quote generation and normal `PreConsumeBilling`.

Image `n` is therefore moved into the pre-consume preparation path. The post-response image handler must detect the existing ratio and avoid applying it twice.

### Asynchronous Tasks

Refactor the preparation portion of `RelayTaskSubmit` into a reusable function that:

1. initializes the selected channel and adapter;
2. validates and normalizes the task request;
3. resolves the model mapping;
4. calculates base per-call pricing;
5. calls adapter `EstimateBilling`;
6. applies validated `OtherRatios` and saturation-safe quota conversion.

Quote-only mode returns after this function. A real quoted request reruns it, validates the persisted quote, then continues through NewAPI pre-consume and upstream submission.

Adapter additions or model changes automatically affect both quote and real calls because both use the same preparation function.

## OpenMontage Workflow

For each billable child call:

1. Build the exact server-side provider request.
2. Request a NewAPI quote on the real endpoint with quote-only mode.
3. Create the chargeable child job with the current OpenMontage multiplier snapshot and the quote snapshot.
4. Create the wallet hold from `ceil(estimated_cost_amount_micro * multiplier_bps / 10_000)`.
5. Send the real request with the quote ID.
6. Bind the returned request/task reference, or recover it through quote status after an ambiguous timeout.
7. Query the final token-scoped receipt.
8. Charge only from the final receipt; release or resize the hold as required.

OpenMontage stores quote ID, quote expiry, estimated quota, estimated provider micro-USD, quota-per-unit, pricing version, `OtherRatios`, and billing fingerprint on the child job. It does not store NewAPI token keys.

If the real call returns `quote_stale` or its response is ambiguous, OpenMontage first queries the old quote status. `consuming` or `accepted` with a request/task reference means it binds that reference and polls the final receipt without replaying the provider request. Only `quoted`, `expired`, or an explicit pre-acceptance `failed` state permits a new quote. Missing or malformed status enters reference recovery and never guesses by resubmitting.

After an old quote is confirmed unconsumed, OpenMontage requests a new quote, locks the job/hold/wallet, resizes the active hold transactionally, updates the job quote snapshot, and retries. A fingerprint/pricing mismatch returned while the quote remains `quoted` caused no upstream call.

If the fresh quote requires a larger hold and the wallet has insufficient available units, the resize transaction leaves the original hold active, stores the fresh quote snapshot, sets the child job to `payment_required_quote`, and returns a payment-required response. OpenMontage does not send the real NewAPI request until a later retry can resize the hold successfully; the ordinary hold/reference deadline eventually releases an abandoned hold.

If the final receipt exceeds the hold, existing `payment_required` behavior remains: never create a negative wallet balance and never expose the result until the final charge succeeds.

## Final Settlement

Quote data is never accepted as final cost. Final settlement continues to use:

```text
GET /api/usage/receipt/request/{request_id}
GET /api/usage/receipt/task/{task_id}
```

`settled` charges from receipt `cost_amount_micro`. `refunded`, `refund_pending`, and `not_chargeable` charge zero and release the hold. A failed video with a refund log is `refunded`; one without a refund log is `refund_pending`, regardless of residual task quota.

## Error Handling

- Invalid or unsupported request: quote returns the same validation error as a real call.
- Missing pricing or invalid adapter ratio: quote is rejected; no hold or upstream call is created.
- Expired, used, mismatched, or repriced quote: real call returns `409 quote_stale` before cost or upstream I/O.
- Fresh quote exceeds the funds available for hold growth: OpenMontage enters `payment_required_quote`, retains the original active hold until retry/deadline, and performs no real NewAPI call.
- Quote issued but OpenMontage crashes before hold: quote expires with no cost.
- Hold created but NewAPI rejects before upstream: OpenMontage releases or resizes the hold.
- `quote_stale` or ambiguous real-call timeout: OpenMontage queries quote status first; an accepted/consuming reference is recovered and never resubmitted.
- Missing final receipt: OpenMontage releases at the receipt deadline and opens reconciliation; it never charges from the quote.

## Security

- Quote-only and quote-status requests require the same ordinary token that owns the call.
- Browser clients never receive NewAPI tokens or quote IDs.
- Cross-token quote, pricing, and receipt lookups return 404.
- Quote rows contain no prompt, body, media, token key, channel key, upstream key, or merchant secret.
- Quote responses omit channel identity and billing expressions.
- Quote creation and consumption are rate-limited and audited without secret-bearing headers.

## Test Requirements

NewAPI tests must cover:

- quote-only performs no pre-consume, consume log, or upstream request;
- quote and real paths produce identical billing fingerprints and pre-consume quota;
- text token bounds, image count, tiered expressions, and every task adapter `OtherRatios` path use the existing billing engine;
- price, group, model, route, channel, request factor, or version changes return `quote_stale` before upstream I/O;
- a quote is consumed once under concurrency;
- process restart and multi-instance database access preserve quote state;
- cross-token quote lookup is 404;
- expired quotes cannot execute;
- accepted request/task references are recoverable;
- a lost accepted response followed by `quote_stale`/timeout recovers one reference and produces exactly one upstream call;
- SQLite, MySQL, and PostgreSQL-compatible queries and migrations.

OpenMontage tests must cover:

- quote micro-USD and multiplier produce the exact integer hold;
- quote stale resizes the active hold atomically without overbooking;
- no local model, duration, resolution, or adapter pricing table exists;
- actual calls carry the quote ID and final settlement ignores quote cost;
- ambiguous timeouts recover request/task references through quote status;
- consumed stale quotes recover their references and are never re-quoted/resubmitted;
- receipt overrun enters `payment_required` without negative balance;
- refunded, refund-pending, missing-receipt, and rejected-quote paths release the correct hold.

## Non-Goals

- Quote mode does not expose NewAPI admin pricing or channel configuration.
- Quote mode does not reserve NewAPI user quota by itself.
- OpenMontage does not reproduce NewAPI billing expressions or adapter ratios.
- Quote cost is not a wallet charge and is not a substitute for a final receipt.
