# Vanta Labs → Vanta Skin Payment Bridge Handoff (Sandbox First)

This document defines the integration contract between the Vanta Labs backend
and the Vanta Skin payment service. It matches the code in `api/_lib/` and the
tests in `test/`.

## System-of-record boundary (critical)

- **Vanta Labs Research is the primary system of record** for orders, sales, inventory, shipping, revenue reporting, affiliate commissions, and customer communications.
- **Vanta Skin only handles payment processing + payment audit/sync records.**
- Vanta Skin must not trigger fulfillment, Shippo labels, Customer.io messages, or marketing flows.
- The customer never leaves Labs. Text Labs shows a customer comes from `customerMessage` only — never `message`, which is internal processor text.

## 1) Base URLs and mode

- **Sandbox:** `https://<vanta-skin-deployment-domain>` (default).
- **Live** requires all three, exactly: `AUTHNET_SANDBOX=false`, `AUTHNET_LIVE_APPROVED=true`, `VERCEL_ENV=production`.
  `AUTHNET_SANDBOX=false` without the other two is a configuration error: every
  payment endpoint answers `503` (`outcome: "rejected"`, not charged) until it is
  fixed. Any other `AUTHNET_SANDBOX` value (unset, `""`, `TRUE`, `on`, …) is sandbox.
- A charge with `"requireSandbox": true` against a live service is refused with
  `422` (`outcome: "rejected"`, `retryable: false`) before the gateway.

## 2) Endpoints

| Method | Path | Caller | Money moves |
|---|---|---|---|
| POST | `/api/payments/charge` | Labs backend (signed) | yes |
| POST | `/api/payments/refund` | Labs backend (signed) | yes |
| POST | `/api/payments/void` | Labs backend (signed) | yes |
| POST | `/api/payments/reconcile` | Labs backend (signed) | **no** (read-only lookup) |
| POST | `/api/payments/session` | Labs backend (signed) | no |
| POST | `/api/payments/session-validate` | browser (hosted component only) | no |
| GET | `/api/payments/embed?session=<token>` | browser (hosted component) | no |
| POST | `/api/payments/webhook` | Authorize.Net only | no |
| GET | `/api/payments/tokenize-config` | browser | no |
| GET | `/api/payments/health` | Labs / ops (signed) | no |
| POST | `/api/payments/sync-retry` | ops / cron (`x-sync-retry-token`) | no |

## 3) Required headers (Labs backend → Skin)

- `content-type: application/json`
- `x-vanta-key-id`, `x-vanta-timestamp` (unix seconds), `x-vanta-nonce` (unique per HTTP request), `x-vanta-signature`
- `x-idempotency-key` — required for charge/refund/void. For charges it is the
  **attempt key** `vskin:charge:<orderId>:<attemptNo>`, unique per attempt.

### Replay and idempotency rules

- Reusing `(x-vanta-key-id, x-vanta-nonce)` → `409`, `outcome: "invalid"`. Use a new nonce on every HTTP retry.
- The idempotency key is **claimed before the gateway is called** (plain INSERT, status `in_progress`). Then:
  - same key, request still running → `409`, `outcome: "in_progress"` (no second gateway call);
  - same key + same body, finished → the stored response, `replayed: true`;
  - same key + different body → `409`, `outcome: "conflict"`;
  - same key whose result is unknown → `502`, `outcome: "uncertain"`, `replayed: true`.
- Requests refused before the claim (bad signature, bad input, sandbox requirement, live not approved) leave no claim behind.

## 4) HMAC signing format

Canonical message, joined with `\n`:

1. HTTP method uppercased
2. URL path only (no query string), e.g. `/api/payments/charge`
3. `x-vanta-timestamp`
4. `x-vanta-nonce`
5. SHA-256 hex of the raw JSON body

`x-vanta-signature = HMAC_SHA256_HEX(sharedSecret, canonicalMessage)`.
Max skew `VANTA_HMAC_MAX_SKEW_SECONDS` (default 300; any value that is not a finite positive number falls back to 300).

## 5) Outcomes (shared vocabulary)

| outcome | HTTP | meaning |
|---|---|---|
| `captured` | 200 | Authorize.Net responseCode 1 with a transId. Money taken. |
| `held` | 202 | responseCode 4 (held for review). Not paid; lock the order; admin review. |
| `declined` | 402 | responseCode 2. Not charged. Retry with a new card/token. |
| `rejected` | 422 | Definitively not charged: responseCode 3, an API error with no transaction response, or Skin refused before the gateway (e.g. sandbox required). `503` with `rejected` = a dependency or configuration is down; also not charged. Retry only if `retryable: true`. |
| `invalid` | 400 (401 bad signature, 409 replayed nonce) | Bad input or signature. Not charged. |
| `in_progress` | 409 | Another request holds this key. |
| `conflict` | 409 | Same key, different body. |
| `uncertain` | 502 | The gateway may or may not have charged (timeout, network error, crash, result not saved). **Never treat as declined.** Lock the order and reconcile. |

Any Skin failure that cannot prove "not charged" answers `uncertain`, never a 4xx.
Labs must branch on `outcome`; a missing or unknown outcome means `uncertain`.

## 6) Charge

### Request (`POST /api/payments/charge`)

```json
{
  "orderId": "order-…", "orderNumber": "VL-10042", "attemptNo": 2,
  "originStorefront": "vantalabsresearch.com",
  "amountCents": 4604, "currency": "USD", "capture": true,
  "requireSandbox": true,
  "opaqueData": { "dataDescriptor": "COMMON.ACCEPT.INAPP.PAYMENT", "dataValue": "<token>" },
  "paymentSession": "vps_<64 hex>",
  "customer": { "email": "…", "firstName": "…", "lastName": "…", "phone": "…" },
  "billTo": { "firstName": "…", "lastName": "…", "address": "…", "city": "…", "state": "TX", "zip": "78701", "country": "US" },
  "shippingCents": 995, "taxCents": 0
}
```

Validation (400 `invalid` otherwise): `orderId` string; `amountCents` positive
integer; `currency` exactly `"USD"`; `originStorefront` in
`VANTA_ALLOWED_ORIGIN_STOREFRONTS`; `opaqueData.dataDescriptor`/`dataValue`
strings; no raw card fields (`cardNumber`, `cardCode`, `cvv`, `cvc`,
`securityCode`, `pan`); `shippingCents`/`taxCents` non-negative integers;
`capture: false` (auth-only) is not supported; `customer`/`billTo` optional
objects (empty fields are omitted). `lineItems` are shape-checked and sent to
the processor (the real goods at their own prices). `paymentSession` (the raw
token from §14) is optional; when present it is validated — exact
order/amount/storefront match, unexpired, unused — and consumed atomically
before the gateway call. When `VANTA_REQUIRE_PAYMENT_SESSION=true`, charges
without it are refused (400 `invalid`).

### What Authorize.Net receives (complete inventory)

`createTransactionRequest`:

- `merchantAuthentication` (API login id + transaction key), `refId` (first 20 hex chars of sha256 of the idempotency key)
- `transactionRequest`:
  - `transactionType`: `authCaptureTransaction`
  - `amount`: `amountCents / 100`, two decimals
  - `payment.opaqueData`: `dataDescriptor`, `dataValue`
  - `order.invoiceNumber`: `VS-` + the first 17 hex digits (upper case) of SHA-256(`orderId`), exactly 20 characters. Deterministic: reconciliation recomputes it from `orderId`, and the charge response returns it as `invoiceNumber` so Labs records it on the attempt. The order id stays linked to the charge in `payment_events`, `payment_idempotency` and Labs' `payment_bridge_attempts`. Reconciliation also matches the order-id invoice used by earlier builds.
  - `order.description`: `<AUTHNET_MERCHANT_DESCRIPTOR> | <originStorefront>` — names the merchant of record and the true originating storefront
  - `lineItems`: the real goods (sku/name/description/quantity/unit price), when supplied (≤ 30)
  - `tax` `{ amount, name: "Tax" }` — only when `taxCents > 0`
  - `shipping` `{ amount, name: "Shipping" }` — only when `shippingCents > 0`
  - `customer.email` — only when given (≤ 255)
  - `billTo` — only the fields given: `firstName` (50), `lastName` (50), `address` (60), `city` (40), `state` (40), `zip` (20), `country` (60), `phoneNumber` (25, from `customer.phone`)
  - `transactionSettings.setting`: `duplicateWindow = 120`

Never sent: raw card data, customer IP, shipping address.
(The SDK itself adds `clientId` = its version string.)

The gateway call has its own timeout (`AUTHNET_TIMEOUT_MS`, default 20000).
A timeout is `uncertain`, never a decline.

### Response

```json
{
  "ok": true, "action": "charge", "orderId": "order-…",
  "outcome": "captured", "paymentStatus": "captured",
  "retryable": false, "gatewayContacted": true,
  "transactionId": "60212345678", "refId": "<20 chars>", "invoiceNumber": "order-…(≤20)",
  "authCode": "ABC123", "cardLast4": "1111", "cardType": "Visa",
  "amountCents": 4604, "currency": "USD", "sandbox": true,
  "processorCode": "1", "message": "<processor text, internal>",
  "customerMessage": null, "replayed": false
}
```

- `paymentStatus` (older builds): `captured | declined | rejected | held | uncertain`.
- `customerMessage` examples: declined → "Your card was declined. Please check the details or use a different card."; rejected → "We couldn't process this card. No payment was taken."; uncertain → "We're confirming your payment with the bank. Please don't pay again."
- If the result was `captured`/`held` but Skin could not save it, the answer is `502 uncertain` **with** `transactionId` — reconcile.
- Refusals before the gateway use the same shape with `gatewayContacted: false` and `transactionId: null`.

## 7) Refund and void

### Refund (`POST /api/payments/refund`)

```json
{ "orderId": "…", "originStorefront": "vantalabsresearch.com", "transactionId": "<charge transId>",
  "amountCents": 1500, "currency": "USD", "cardNumberMasked": "1111" }
```

`cardNumberMasked` is required: the card's last 4 digits (`"1111"`, or `"XXXX1111"`). Missing or anything else → 400 `invalid`; there is no default. Currency, if sent, must be `USD`.

Authorize.Net receives: `refId`, `transactionType: refundTransaction`, `amount`, `payment.creditCard { cardNumber: "XXXX1111", expirationDate: "XXXX" }`, `refTransId`.

### Void (`POST /api/payments/void`)

```json
{ "orderId": "…", "originStorefront": "vantalabsresearch.com", "transactionId": "<charge transId>", "amountCents": 4604 }
```

`amountCents` is optional when Skin recorded the charge (its amount is used); otherwise 400.
Authorize.Net receives: `refId`, `transactionType: voidTransaction`, `refTransId`.

### Response (both)

Same idempotency and outcome→HTTP mapping as charges. Body:
`ok, action, orderId, outcome, paymentStatus, retryable, gatewayContacted, transactionId, originalTransactionId, refId, amountCents, currency, sandbox, processorCode, message, customerMessage (null), replayed`.

- `transactionId` = the **new** refund transaction id (void: the voided id); `originalTransactionId` = the charge's id.
- `paymentStatus`: refund `refunded | refund_failed | refund_held | refund_uncertain`; void `voided | void_failed | void_held | void_uncertain`.

## 8) Reconcile (new; no money moves)

`POST /api/payments/reconcile`, signed like the others (nonce stored, no idempotency key needed).

```json
{ "orderId": "…", "idempotencyKey": "vskin:charge:<orderId>:<n>", "invoiceNumber": "<orderId, ≤20 chars>",
  "amountCents": 4604, "attemptStartedAt": "2026-10-16T12:00:00.000Z", "knownTransactionIds": ["…"] }
```

Response `200`:

```json
{ "ok": true, "orderId": "…", "outcome": "captured", "transactionId": "…", "cardLast4": "1111",
  "cardType": "Visa", "amountCents": 4604, "source": "skin_record" }
```

1. Skin's own records first (the idempotency row, then the charge audit row) → `source: "skin_record"`.
2. Otherwise Authorize.Net: the unsettled list, then batches settled in the last 2 days, for a transaction whose invoice is the orderId-derived invoice (§6) or the `invoiceNumber` Labs sent (a legacy number recorded earlier), with the same amount, submitted at/after `attemptStartedAt` (60 s clock tolerance), not in `knownTransactionIds`; details are fetched for the card. → `source: "gateway_lookup"`. Several matches: captured wins over held, declined, rejected.
3. `not_found` only when the lookups completed without error and the attempt is ≥ 30 minutes old (measured from the later of `attemptStartedAt` and Skin's claim). Otherwise `pending`.

Gateway statuses: `capturedPendingSettlement`/`settledSuccessfully` → captured; `declined`/`failedReview` → declined; `generalError`/`communicationError`/`expired`/`voided` → rejected; review and unknown statuses → held.
The lookups need Authorize.Net's Transaction Details API enabled on the merchant account.

### Refunds and voids

The same endpoint with `"operation": "refund"` or `"void"` and the charge being
reversed:

```json
{ "operation": "refund", "orderId": "…", "idempotencyKey": "vskin:refund:<orderId>:<n>",
  "originalTransactionId": "<charge transId>", "amountCents": 1500,
  "attemptStartedAt": "…", "knownTransactionIds": ["<earlier refund transIds>"] }
```

Response adds `operation` and `originalTransactionId`; `captured` means the
refund/void happened.

1. Skin's own records (refund/void idempotency row, then audit row), only when they name the same `originalTransactionId`.
2. Refund: refund transactions (`refundPendingSettlement`, `refundSettledSuccessfully`) of the same amount since the attempt began, not in `knownTransactionIds`; each candidate's details must give `refTransId` = `originalTransactionId` (at most 10 detail lookups; more counts as a failed lookup).
   Void: the original charge's details — `voided` → captured; settled → `rejected` (a settled charge cannot be voided); still capturable → `not_found` after 30 minutes, else `pending`.
3. `not_found` / `pending` as for charges.

### Decline categories

A `declined`/`rejected` charge answer carries `declineCategory`, from the
Authorize.Net reason code: `card_number` (6, 37, 315), `expiry` (7, 8, 316,
317), `cvv` (44, 65, 78), `billing` (27, 127), `billing_and_cvv` (45),
`duplicate` (11), otherwise `generic`. Labs turns it into the customer's
sentence.

## 9) Skin → Labs callback (`VANTA_LABS_SYNC_ENDPOINT_URL`)

Headers: the same HMAC scheme with the callback key, `x-idempotency-key` = `eventId`.

### Charge result (sent for captured / declined / rejected / held; not for uncertain)

```json
{ "eventId": "bridge:charge:<idempotencyKey>:<transId|none>:<outcome>", "source": "vanta-skin-payment-bridge",
  "action": "charge", "attemptKey": "vskin:charge:<orderId>:<n>", "orderId": "…", "originStorefront": "…",
  "outcome": "captured", "paymentStatus": "captured", "transactionId": "…",
  "amountCents": 4604, "currency": "USD", "cardLast4": "1111", "cardType": "Visa",
  "sandbox": true, "processorCode": "1", "message": "…", "occurredAt": "…" }
```

### Refund / void result

`action: "refund" | "void"`, `eventId: bridge:<action>:<key>:<transId|none>:<outcome>`,
`transactionId` = new refund id (void: the voided id), `originalTransactionId` = charge id,
`amountCents` = refunded amount (void: the original amount), `paymentStatus` as in §7.

### Authorize.Net-webhook update

`action: "webhook_update"`, `eventId: webhook:<notificationId>`, `outcome: "captured"`,
`paymentStatus: "paid" | "refunded" | "voided"`, `amountCents` = the gateway's verified amount,
`transactionId`, `originalTransactionId` (refund/void), `attemptKey`, `cardLast4`, `cardType`, `webhookEventType`.
Forwarded only when verified (§10).

### Labs responses and Skin's retries

- `2xx` = processed (or already processed) → `delivered`.
- `422` = permanently rejected → `dead` immediately, no more retries.
- anything else (409, 5xx, timeout, redirect) → `failed`, retried with backoff 1m, 2m, 4m … capped at 6h; after 15 attempts → `dead` with the last error.

The inline callback is sent only after the charge result is saved, with a short
timeout (`VANTA_LABS_SYNC_TIMEOUT_MS`, default 4000). Its failure never changes
the charge response. `POST /api/payments/sync-retry` (header
`x-sync-retry-token`) delivers due rows (`next_attempt_at <= now`) oldest first;
run it from a cron.

## 10) Authorize.Net webhook handling

- `X-ANET-Signature` must verify (fails closed when `AUTHNET_SIGNATURE_KEY` is unset) → else 401.
- Every verified notification is recorded once in `authnet_webhook_events` (key: `notificationId`, or `sha256-<hash of body>` when absent) with a `verification` reason.
- An event name alone never makes anything paid. `authcapture.created` / `capture.created` are forwarded only when the transaction id matches a Skin charge row whose outcome is captured, `payload.responseCode == 1`, and `authAmount` (or `settleAmount`) equals the recorded amount. `refund.created` / `void.created` must match a recorded refund / void row the same way.
- Everything else is recorded and not forwarded.

## 11) Supabase (Skin side)

- `payment_request_replays` — nonce replay lock
- `payment_idempotency` — `status` (`in_progress | completed | uncertain`), request hash, stored response
- `payment_events` — audit trail incl. `outcome`, `card_last4`, `card_type`, `ref_id`, `idempotency_key`, `auth_amount_cents`, `original_transaction_id`; one charge row per attempt key
- `authnet_webhook_events` — webhook ledger incl. `verification`
- `payment_order_sync_events` — callback outbox incl. `next_attempt_at` and `dead`

- `payment_sessions` — embedded-form sessions (token hash, order, amount, storefront, parent origin, expiry, consumed_at)

Apply `supabase/migrations/20261016003000_payment_sessions.sql`,
`20261017000000_payment_reliability.sql` and
`20261017001000_payment_sessions_hardening.sql` **before** deploying this code
(the code fails closed — 503, not charged — without them).
Manual reverse steps: `supabase/migrations/ROLLBACK-20261017000000_payment_reliability.sql`.
`anon` and `authenticated` have no privileges on the payment tables.

## 12) Security / compliance

- Processor and Supabase secrets stay server-side. The Accept.js token is never logged or stored (`[redacted]` in audit rows).
- Do not falsify product descriptions, storefront source, or order metadata. The Authorize.Net description names the originating storefront.
- Do not switch to live processing until written approval and production sign-off (and then via the three variables in §1).

## 13) Environment variables (Vanta Skin)

Required: `AUTHNET_API_LOGIN_ID`, `AUTHNET_TRANSACTION_KEY`, `AUTHNET_CLIENT_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `VANTA_HMAC_KEY_ID` +
`VANTA_HMAC_SHARED_SECRET` (or `VANTA_HMAC_KEYS_JSON`).

Mode: `AUTHNET_SANDBOX`, `AUTHNET_LIVE_APPROVED`, `VERCEL_ENV` (see §1).

Optional: `AUTHNET_SIGNATURE_KEY` (webhooks), `AUTHNET_MERCHANT_DESCRIPTOR`,
`AUTHNET_TIMEOUT_MS` (20000), `VANTA_HMAC_MAX_SKEW_SECONDS` (300),
`VANTA_ALLOWED_ORIGIN_STOREFRONTS` (`vantalabsresearch.com`).

Embedded component: `VANTA_EMBED_ALLOWED_ORIGINS` (exact https origins allowed
to iframe the hosted component, default `https://vantalabsresearch.com`),
`VANTA_PAYMENT_SESSION_TTL_SECONDS` (900), `VANTA_REQUIRE_PAYMENT_SESSION`
(false; set true once every Labs charge carries a session token).

Callbacks: `VANTA_LABS_SYNC_ENDPOINT_URL`, `VANTA_LABS_SYNC_KEY_ID`,
`VANTA_LABS_SYNC_SHARED_SECRET`, `VANTA_LABS_SYNC_TIMEOUT_MS` (4000),
`VANTA_LABS_PROTECTION_BYPASS` (previews only), `VANTA_SYNC_RETRY_TOKEN`,
`VANTA_SYNC_RETRY_BATCH_SIZE` (25).

## 14) Embedded payment component (hosted on Vanta Skin)

The Vanta Labs checkout embeds a Vanta Skin-hosted payment component in an
iframe. Raw card data is entered only inside that iframe and is tokenized
there by Accept.js; the Vanta Labs page and backend only ever see the
Authorize.net `opaqueData` token. The customer never leaves
`vantalabsresearch.com`.

### Accept.js iframe support (evaluated before implementation)

Accept.js is supported in this configuration:

- Accept.js executes in whatever window loads it. Inside the iframe it is
  loaded from the Authorize.net CDN (`https://jstest.authorize.net/v1/Accept.js`
  in sandbox) and `Accept.dispatchData()` posts directly to the Authorize.net
  tokenization API over CORS-enabled HTTPS (`apitest.authorize.net`). Neither
  call depends on the top-level page's origin, so cross-origin framing works.
- The iframe document must be HTTPS (the Vanta Skin deployment is).
- The component's CSP allows scripts only from the Authorize.net CDN plus the
  hash-locked inline bootstrap, and connections only to the Vanta Skin origin
  and the Authorize.net tokenization endpoints.
- Only the public API login id and public client key reach the browser (they
  are designed for client-side use). The transaction key and signature key
  never leave the server.
- If the Labs checkout adds a `sandbox` attribute to the iframe it must
  include `allow-scripts allow-forms allow-same-origin`, or Accept.js cannot
  run.
- Accept.js sets no cookies, so third-party cookie blocking does not affect
  tokenization (relevant for Safari / ITP).

### Flow

1. Labs backend (HMAC-signed) calls `POST /api/payments/session` with
   `{ orderId, amountCents, currency, originStorefront, embedOrigin }`.
   `embedOrigin` is the exact https origin of the Labs checkout page and must
   be in `VANTA_EMBED_ALLOWED_ORIGINS`.
2. Response: `{ ok, sessionToken, sessionId, expiresAt, embedUrl, sandbox }`.
   The raw token is returned once; only its SHA-256 hash is stored. Sessions
   are single-use and expire after `VANTA_PAYMENT_SESSION_TTL_SECONDS`.
3. Labs checkout iframes `embedUrl`. Reference parent implementation:
   `assets/js/payment-embed-parent.js` (copy/adapt into the Labs codebase).
4. The iframe validates the session via `POST /api/payments/session-validate`
   (browser-facing; token is the bearer credential) and renders the card form.
5. The frame has no Pay button of its own: the checkout's Pay button posts
   `vanta:pay:submit`, and Enter in a card field posts
   `vanta:pay:submit-request` so the checkout runs that same action. The frame
   then tokenizes with Accept.js and posts `vanta:pay:tokenized` with
   `opaqueData`, or `vanta:pay:error` with Accept.js's `code` (E_WC_05 …,
   never card data or raw text) for the checkout to word.
6. Labs checkout sends `opaqueData` + `paymentSession` to its backend, which
   calls `POST /api/payments/charge` as before (HMAC + idempotency). The
   charge re-validates the session (exact order/amount/storefront match) and
   consumes it atomically before the gateway call. A session rejection is a
   definitive 400/409 with `gatewayContacted: false`, never a 502.
7. A session is spent by the first charge that uses it, whatever the answer.
   After any charge answer that returns the shopper to the form (decline,
   retryable failure), the checkout opens a **new** session and frame.

### Cross-origin messaging contract

- Messages parent → iframe and iframe → parent always use an explicit target
  origin (the server-approved `embedOrigin`), never a wildcard.
- Receivers check `event.origin` for an exact match before reading anything;
  the parent also checks `event.source` is its own iframe, and charges only a
  token it asked for.
- Every message carries `sessionId` (first 24 hex chars of the token's
  SHA-256, computable by both sides); mismatched messages are dropped.
- Message types: `vanta:pay:ready`, `vanta:pay:tokenized`, `vanta:pay:error`,
  `vanta:pay:submit-request` (iframe → parent); `vanta:pay:submit`
  (parent → iframe).
- `opaqueData` is forwarded to the Labs backend immediately; it is never
  logged or persisted in the browser.

### Embedding restrictions

- `GET /api/payments/embed` sends `Content-Security-Policy: frame-ancestors`
  with exactly the `VANTA_EMBED_ALLOWED_ORIGINS` allowlist; no other site can
  frame the component.
- `X-Frame-Options` is deliberately not sent (it cannot express a cross-origin
  allowlist; `frame-ancestors` supersedes it in modern browsers).
- Responses are `cache-control: no-store` with `referrer-policy: no-referrer`.
- The frame's CSP allows scripts only from its hashed inline bootstrap and the
  Accept.js hosts, and connections only to itself and the Authorize.net js/api
  hosts (Accept.js fetches its core library from the js host to verify it).
- `embed` and `session-validate` answer configuration or database failures
  with a generic 503; detail goes to the server log only.

## Health check (no money moves)


`GET /api/payments/health`, signed exactly like the payment calls (canonical
message over an empty body). `200` proves the bridge secret matches; `401` means
it does not. The body reports `sandbox` and `authnetMode`
(`sandbox | live | misconfigured`).

`GET /api/payments/health?callback=1` also sends Labs a signed
`{ "type": "ping", "eventId": "ping:<uuid>", "challenge": "<hex>", "sandbox": <bool> }`;
Labs answers `{ "pong": "<challenge>" }` only after verifying the signature, so
`checks.labsCallback = "verified"` proves both copies of
`VANTA_LABS_SYNC_SHARED_SECRET` match. The response contains states only, never
configuration values. Nonces are not stored; nothing is written.
