# Vanta Skin — Storefront

Static e-commerce site (plain HTML/CSS/JS) with Vercel serverless payment APIs for Authorize.net.

## Before launch
1. **`assets/js/config.js`** — set legal business name, support email, address, returns address, governing state. These fill every page and policy automatically.
2. **Payments** — configure server-side payment env vars and Supabase migration below, then set `paymentsEnabled: true` in `assets/js/config.js`.
3. **Forms** — newsletter/contact/track forms show a confirmation only. Add an `action` URL (e.g. Formspree, Klaviyo) to send them somewhere.
4. **Products** — edit `assets/js/products.js` (prices, descriptions, images in `assets/img/`).
5. Have the policies reviewed by an attorney, and fill in the real INCI ingredient list on the jar label.

## Pages
Home, Shop, Product, Cart, Checkout, Our Story, Contact, FAQ, Track Order, Shipping, Returns & Refunds, Privacy, Terms, Product Disclaimer, Accessibility, 404.

## Authorize.net payment bridge (multi-storefront architecture)

> Sandbox only. Live processing for any storefront other than Vanta Skin needs
> written confirmation from Authorize.net and the acquiring bank that this
> merchant account is approved for that storefront and its product category.
> No such approval is on file in this repository.

This repository includes server-to-server payment endpoints under `/api/payments`:

- `POST /api/payments/charge`
- `POST /api/payments/refund`
- `POST /api/payments/void`
- `POST /api/payments/reconcile` (read-only: what happened to a charge, refund or void attempt; no money moves)
- `POST /api/payments/webhook` (Authorize.net only)
- `POST /api/payments/sync-retry` (re-deliver due status callbacks to Vanta Labs; run from a cron)
- `GET /api/payments/health` (signed readiness check)

Vanta Labs remains the system of record for orders, fulfillment, inventory, and customer communications. Vanta Skin stores payment/security/audit/sync records only. The full contract is in `VANTA_LABS_HANDOFF.md`.

### Outcomes

Every payment response carries an `outcome`: `captured` (200), `held` (202),
`declined` (402), `rejected` (422; 503 when refused because a dependency or the
configuration is down), `invalid` (400; 401 bad signature), `in_progress` /
`conflict` (409), `uncertain` (502). `uncertain` means the gateway may have
charged (timeout, network error, result not saved) and is never a decline;
Labs reconciles it through `/api/payments/reconcile`. `customerMessage` is the
only text meant for a shopper. A `declined` or `rejected` charge also carries
`declineCategory` (`card_number`, `expiry`, `cvv`, `billing`,
`billing_and_cvv`, `duplicate` or `generic`), from Authorize.net's reason code.

`/api/payments/reconcile` takes `operation` (`charge` by default, `refund` or
`void`). A refund is matched only when the gateway's transaction details name
`originalTransactionId` as its `refTransId`; a void is answered by the original
charge's status (`voided` → done; settled → it cannot have happened).

3-D Secure is not supported: Accept.js has none, and the
`cardholderAuthentication` API element is deprecated and needs a separate
authentication provider. Nothing is sent for it.

### Security and reliability controls

- HMAC-SHA256 request authentication (`x-vanta-key-id`, `x-vanta-timestamp`, `x-vanta-nonce`, `x-vanta-signature`)
- Persistent nonce replay protection (`payment_request_replays`)
- Atomic idempotency: the key is claimed with a plain INSERT before Authorize.net is called, the result is saved before anything else, and a result that cannot be saved after money moved is answered `uncertain` with the transaction id (`payment_idempotency`)
- Our own timeout around every Authorize.net call (`AUTHNET_TIMEOUT_MS`); the SDK never calls back on network errors
- Server-side secret handling only; the Accept.js token is never stored or logged
- Authorize.net webhook signature verification (`X-ANET-SIGNATURE`); fails closed. A webhook is forwarded to Labs only when it matches a recorded captured transaction with an approved response code and the same amount
- Callback outbox with exponential backoff (1m … 6h), 15 attempts, then `dead`; a Labs `422` is dead immediately
- `anon` / `authenticated` have no privileges on payment tables

### What Authorize.net receives

Charge: `refId` (sha256 of the idempotency key, 20 chars), `authCaptureTransaction`,
amount, `opaqueData`, `order.invoiceNumber` (`VS-` + hash of the order id, 20
chars), `order.description` (`<AUTHNET_MERCHANT_DESCRIPTOR> | vanta.skin`),
tax and shipping amounts when > 0, `customer.email` when given, `billTo` (name,
address, city, state, zip, country, phone) when given, truncated to
Authorize.net's limits, and `duplicateWindow = 120`. No line items, product names
or customer IP. Refund: `refId`, `refundTransaction`, amount, masked card
`XXXX####` / `XXXX`, `refTransId`. Void: `refId`, `voidTransaction`, `refTransId`.

### Required environment variables

#### Payment processor

- `AUTHNET_API_LOGIN_ID`
- `AUTHNET_TRANSACTION_KEY`
- `AUTHNET_CLIENT_KEY` (public Accept.js client key for browser tokenization)
- `AUTHNET_SIGNATURE_KEY` (required for webhooks; without it every webhook is refused)
- `AUTHNET_MERCHANT_DESCRIPTOR` (optional)
- `AUTHNET_TIMEOUT_MS` (optional, default `20000`)

#### Sandbox / live (strict)

Sandbox unless **all three** hold: `AUTHNET_SANDBOX=false`, `AUTHNET_LIVE_APPROVED=true`,
`VERCEL_ENV=production`. `AUTHNET_SANDBOX=false` without the other two makes every
payment endpoint refuse with `503` (not charged). Any other `AUTHNET_SANDBOX`
value is sandbox. Do not set `AUTHNET_LIVE_APPROVED` until written approval is on file.

#### HMAC bridge authentication

Use either:

- `VANTA_HMAC_KEY_ID` + `VANTA_HMAC_SHARED_SECRET`

or:

- `VANTA_HMAC_KEYS_JSON` (JSON object mapping key id to shared secret)

Optional:

- `VANTA_HMAC_MAX_SKEW_SECONDS` (default `300`; non-numeric, zero or negative values fall back to `300`)
- `VANTA_ALLOWED_ORIGIN_STOREFRONTS` (comma-separated allowlist, default `vanta.skin`)

#### Supabase

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

#### Labs synchronization callback (recommended)

- `VANTA_LABS_SYNC_ENDPOINT_URL` (server endpoint in Vanta Labs that receives payment status events)
- `VANTA_LABS_SYNC_KEY_ID`
- `VANTA_LABS_SYNC_SHARED_SECRET`
- `VANTA_LABS_SYNC_TIMEOUT_MS` (default `4000`)
- `VANTA_LABS_PROTECTION_BYPASS` (Vanta Labs project's Vercel "Protection Bypass for Automation" secret; only while Labs is behind Vercel Deployment Protection, e.g. its previews. Sent as the `x-vercel-protection-bypass` header on callbacks. HMAC is still required.)
- `VANTA_SYNC_RETRY_TOKEN` (required to call `/api/payments/sync-retry`)
- `VANTA_SYNC_RETRY_BATCH_SIZE` (default `25`)

### Database migration

Apply **before** deploying code that depends on it:

```bash
supabase db push
```

Migration files:

- `supabase/migrations/20261016000000_payment_bridge.sql`
- `supabase/migrations/20261016001000_payment_webhook_reconciliation.sql`
- `supabase/migrations/20261016002000_payment_sync_outbox.sql`
- `supabase/migrations/20261017000000_payment_reliability.sql` (idempotency status, card data columns, outbox backoff/dead letter, privilege revocation)

Manual reverse steps for the last one: `supabase/migrations/ROLLBACK-20261017000000_payment_reliability.sql` (all statements commented out; not a migration).

### Tests

`npm test` runs `node --test`. Everything is mocked: an in-memory store, a fake
gateway (the real SDK executor is replaced with one that throws), and a recorded
Labs callback. No test reaches the network.

### Vanta Labs integration handoff

See `VANTA_LABS_HANDOFF.md` for the integration contract (headers, canonical signing format, payloads, outcomes, reconcile, callbacks, and Supabase expectations).

### Browser tokenization

- Checkout now loads `assets/js/payments.js`.
- If `window.STORE.authnet.enabled` and `window.STORE.paymentsEnabled` are true, the checkout form tokenizes card data with Authorize.net Accept.js and attaches `opaqueData` to the order object.
- Implement `window.VANTA_PAY(order)` to send order + tokenized payload to your backend flow.

### Sandbox test checklist

1. Keep `AUTHNET_SANDBOX=true` and leave `AUTHNET_LIVE_APPROVED` unset.
2. Use Authorize.net sandbox credentials and card test numbers.
3. Confirm a retry with the same idempotency key returns the stored result (`replayed: true`) and a concurrent one gets `409 in_progress`.
4. Confirm a duplicate nonce is rejected.
5. Confirm the Authorize.net transaction carries only the fields listed under "What Authorize.net receives" (no line items).
6. Confirm raw card fields are rejected (only `opaqueData` accepted) and non-USD currency is rejected.
7. Confirm callbacks reach Vanta Labs and duplicate callbacks are deduplicated by `eventId`.
8. Confirm failed callbacks are retried by `/api/payments/sync-retry` with backoff, and a Labs `422` is dead-lettered.
9. Confirm `/api/payments/reconcile` reports a sandbox charge from Skin's records and, for an unknown key, `pending` then `not_found` after 30 minutes.

## Vercel Deployment Protection (previews)

Preview deployments of both projects are behind Vercel Authentication. Keep it
on. Server-to-server calls carry the *other* project's "Protection Bypass for
Automation" secret in the `x-vercel-protection-bypass` header:

- Labs -> Skin: Labs sends vanta-skin's secret (`VANTA_SKIN_PROTECTION_BYPASS` on vanta-labs).
- Skin -> Labs callbacks: Skin sends vanta-labs's secret (`VANTA_LABS_PROTECTION_BYPASS` here).
- Authorize.net -> Skin webhook (`/api/payments/webhook`): Authorize.net cannot
  add headers, so a *sandbox* webhook pointed at a preview needs
  `?x-vercel-protection-bypass=<vanta-skin secret>` on the URL. The
  `X-ANET-Signature` check still applies. Never do this for production.
