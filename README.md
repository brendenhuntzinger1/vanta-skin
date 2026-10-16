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
- `SUPABASE_ORDERS_TABLE` (default `orders`)
- `SUPABASE_ORDER_ID_COLUMN` (default `id`)
- `SUPABASE_ORDER_AMOUNT_COLUMN` (default `total_amount_cents`)
- `SUPABASE_ORDER_CURRENCY_COLUMN` (default `currency`)
- `SUPABASE_ORDER_PAYMENT_STATUS_COLUMN` (default `payment_status`)
- `SUPABASE_ORDER_PAYMENT_TRANSACTION_COLUMN` (default `payment_transaction_id`)
- `SUPABASE_ORDER_UPDATED_AT_COLUMN` (default `updated_at`)

### Database migration

Run:

```bash
supabase db push
```

Migration file:

- `supabase/migrations/20261016000000_payment_bridge.sql`

This creates durable idempotency/replay/webhook/payment audit tables and optional payment columns on `orders` if missing.
If the first migration is already applied, also apply the webhook reconciliation follow-up migration:

- `supabase/migrations/20261016001000_payment_webhook_reconciliation.sql`

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
5. Confirm order amount mismatch is rejected before authorization.
6. Confirm `payment_events` + order payment status are updated.
