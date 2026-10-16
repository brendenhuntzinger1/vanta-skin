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

## Authorize.net payment bridge (approved multi-storefront architecture)

This repository now includes server-to-server payment endpoints under `/api/payments`:

- `POST /api/payments/charge`
- `POST /api/payments/refund`
- `POST /api/payments/void`
- `POST /api/payments/webhook`
- `POST /api/payments/sync-retry` (re-deliver pending status callbacks to Vanta Labs)

Vanta Labs remains the system of record for orders, fulfillment, inventory, and customer communications. Vanta Skin stores payment/security/audit/sync records only.

### Security controls

- HMAC-SHA256 request authentication (`x-vanta-key-id`, `x-vanta-timestamp`, `x-vanta-nonce`, `x-vanta-signature`)
- Persistent nonce replay protection (`payment_request_replays`)
- Persistent idempotency keys with response replay (`payment_idempotency`)
- Server-side secret handling only (`AUTHNET_TRANSACTION_KEY`, Supabase service role key)
- Authorize.net webhook signature verification (`X-ANET-SIGNATURE`) when `AUTHNET_SIGNATURE_KEY` is configured

### Required environment variables

#### Payment processor

- `AUTHNET_API_LOGIN_ID`
- `AUTHNET_TRANSACTION_KEY`
- `AUTHNET_CLIENT_KEY` (public Accept.js client key for browser tokenization)
- `AUTHNET_SIGNATURE_KEY` (recommended for webhook signature checks)
- `AUTHNET_SANDBOX=true` for sandbox mode (do not disable until approved)
- `AUTHNET_MERCHANT_DESCRIPTOR` (optional)

#### HMAC bridge authentication

Use either:

- `VANTA_HMAC_KEY_ID` + `VANTA_HMAC_SHARED_SECRET`

or:

- `VANTA_HMAC_KEYS_JSON` (JSON object mapping key id to shared secret)

Optional:

- `VANTA_HMAC_MAX_SKEW_SECONDS` (default `300`)
- `VANTA_ALLOWED_ORIGIN_STOREFRONTS` (comma-separated allowlist, default `vantalabsresearch.com`)

#### Supabase

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

#### Labs synchronization callback (recommended)

- `VANTA_LABS_SYNC_ENDPOINT_URL` (server endpoint in Vanta Labs that receives payment status events)
- `VANTA_LABS_SYNC_KEY_ID`
- `VANTA_LABS_SYNC_SHARED_SECRET`
- `VANTA_LABS_SYNC_TIMEOUT_MS` (default `8000`)
- `VANTA_LABS_PROTECTION_BYPASS` (Vanta Labs project's Vercel "Protection Bypass for Automation" secret; only while Labs is behind Vercel Deployment Protection, e.g. its previews. Sent as the `x-vercel-protection-bypass` header on callbacks. HMAC is still required.)
- `VANTA_SYNC_RETRY_TOKEN` (required to call `/api/payments/sync-retry`)
- `VANTA_SYNC_RETRY_BATCH_SIZE` (default `25`)

### Database migration

Run:

```bash
supabase db push
```

Migration files:

- `supabase/migrations/20261016000000_payment_bridge.sql`
- `supabase/migrations/20261016001000_payment_webhook_reconciliation.sql`
- `supabase/migrations/20261016002000_payment_sync_outbox.sql`

These create durable idempotency/replay/webhook/payment audit tables plus an outbound sync outbox for reliable callbacks to Vanta Labs.

### Vanta Labs integration handoff

See `/home/runner/work/vanta-skin/vanta-skin/VANTA_LABS_HANDOFF.md` for the Stage 2 integration contract (headers, canonical signing format, payloads, response semantics, and Supabase flow expectations).

### Browser tokenization

- Checkout now loads `assets/js/payments.js`.
- If `window.STORE.authnet.enabled` and `window.STORE.paymentsEnabled` are true, the checkout form tokenizes card data with Authorize.net Accept.js and attaches `opaqueData` to the order object.
- Implement `window.VANTA_PAY(order)` to send order + tokenized payload to your backend flow.

### Sandbox test checklist

1. Keep `AUTHNET_SANDBOX=true`.
2. Use Authorize.net sandbox credentials and card test numbers.
3. Confirm duplicate retry with same idempotency key returns cached result.
4. Confirm duplicate nonce is rejected.
5. Confirm line-item totals match `amountCents` when line items are sent.
6. Confirm raw card fields are rejected (only `opaqueData` accepted).
7. Confirm callbacks reach Vanta Labs and duplicate callbacks are deduplicated by `eventId`.
8. Confirm failed callbacks are retried with `/api/payments/sync-retry`.

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
