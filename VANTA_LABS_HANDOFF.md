# Vanta Labs → Vanta Skin Payment Bridge Handoff (Sandbox First)

This document defines the exact integration contract for the Vanta Labs backend to call the Vanta Skin payment service.

## System-of-record boundary (critical)

- **Vanta Labs Research is the primary system of record** for orders, sales, inventory, shipping, revenue reporting, affiliate commissions, and customer communications.
- **Vanta Skin only handles payment processing + payment audit/sync records.**
- Vanta Skin must not trigger fulfillment, Shippo labels, Customer.io messages, or marketing flows.

## 1) Base URLs

- **Sandbox:** `https://<vanta-skin-deployment-domain>` with `AUTHNET_SANDBOX=true`
- **Production (do not enable yet):** same endpoints after explicit approval.

## 2) Endpoints

All endpoints are `POST` and require bridge authentication headers.

- `POST /api/payments/charge`
- `POST /api/payments/refund`
- `POST /api/payments/void`
- `POST /api/payments/webhook` (Authorize.net only; not called by Vanta Labs)
- `GET /api/payments/tokenize-config` (browser/client config fetch)
- `POST /api/payments/sync-retry` (ops endpoint for replaying failed payment-status callbacks to Vanta Labs)

## 3) Required Headers (Vanta Labs backend → Vanta Skin backend)

- `content-type: application/json`
- `x-vanta-key-id: <key id>`
- `x-vanta-timestamp: <unix-seconds>`
- `x-vanta-nonce: <unique random nonce per request>`
- `x-vanta-signature: <hex hmac sha256>`
- `x-idempotency-key: <unique key per operation intent>`

### Replay and idempotency rules

- Reusing the same `(x-vanta-key-id, x-vanta-nonce)` is rejected (`409`).
- For retries, generate a **new nonce** each attempt but reuse the same idempotency key for the same operation intent.
- Idempotency key is required for `charge/refund/void`.
- If same idempotency key is reused with a different payload hash, request is rejected (`409`).
- If same idempotency key and same payload hash are reused, cached response is returned with `replayed: true`.

## 4) HMAC Signing Format

### Canonical message

Join these fields with newline (`\n`), exactly in order:

1. HTTP method uppercased (e.g. `POST`)
2. URL path only (no query string), e.g. `/api/payments/charge`
3. `x-vanta-timestamp`
4. `x-vanta-nonce`
5. SHA-256 hex of raw JSON body string

Canonical string example:

`POST\n/api/payments/charge\n1729036800\n5f4dcc3b-...\n<sha256-body-hex>`

Signature:

- `x-vanta-signature = HMAC_SHA256_HEX(sharedSecret, canonicalMessage)`

Time skew window:

- Max skew defaults to 300 seconds (`VANTA_HMAC_MAX_SKEW_SECONDS`).

## 5) Charge Request/Response Contract

### Request JSON (`POST /api/payments/charge`)

```json
{
  "orderId": "labs-order-123",
  "originStorefront": "vantalabsresearch.com",
  "amountCents": 12995,
  "currency": "USD",
  "capture": true,
  "opaqueData": {
    "dataDescriptor": "COMMON.ACCEPT.INAPP.PAYMENT",
    "dataValue": "<accept-js-token>"
  },
  "customer": {
    "email": "buyer@example.com"
  },
  "lineItems": [
    {
      "id": "resp-kit-1",
      "sku": "RESP-KIT-1",
      "name": "Respiratory Research Kit",
      "description": "Respiratory protocol kit",
      "quantity": 1,
      "unitPriceCents": 12995
    }
  ]
}
```

Validation notes:
- `originStorefront` must be in the Vanta Skin allowlist (`VANTA_ALLOWED_ORIGIN_STOREFRONTS`).
- `amountCents` is authoritative (computed by the storefront from its order and signed). `lineItems` are the real goods at their own prices (positive integer `quantity`, non-negative integer `unitPriceCents`) and need not sum to `amountCents`: coupons, free items and credits are why.
- Optional `orderNumber` (shown as the Authorize.net invoice number), `shippingCents` and `taxCents` (itemised in Authorize.net's shipping and tax fields).
- The transaction description is `<originStorefront> order <orderNumber> | processed by <AUTHNET_MERCHANT_DESCRIPTOR>`: the originating storefront is always named.
- Raw card fields (PAN/CVV/etc.) are rejected; only `opaqueData` is accepted.

### Success response (`200`)

```json
{
  "ok": true,
  "action": "charge",
  "orderId": "labs-order-123",
  "transactionId": "1234567890",
  "paymentStatus": "captured",
  "processorCode": "1",
  "message": "This transaction has been approved.",
  "sandbox": true,
  "replayed": false
}
```

### Declined/processor-failed response (`402`)

```json
{
  "ok": false,
  "action": "charge",
  "orderId": "labs-order-123",
  "transactionId": null,
  "paymentStatus": "declined",
  "processorCode": "2",
  "message": "Card declined",
  "sandbox": true,
  "replayed": false
}
```

### Validation/auth errors (`4xx`)

```json
{ "ok": false, "error": "..." }
```

## 6) Refund Request/Response Contract

### Request JSON (`POST /api/payments/refund`)

```json
{
  "orderId": "labs-order-123",
  "originStorefront": "vantalabsresearch.com",
  "transactionId": "1234567890",
  "amountCents": 12995,
  "currency": "USD",
  "cardNumberMasked": "1111",
  "expirationDate": "XXXX"
}
```

`cardNumberMasked` must be either:
- last 4 digits (example: `1111`), or
- `XXXX####` format (example: `XXXX1111`)

### Response

- `200` when refund succeeds with `paymentStatus: "refunded"`
- `402` when refund fails with `paymentStatus: "refund_failed"`

## 7) Void Request/Response Contract

### Request JSON (`POST /api/payments/void`)

```json
{
  "orderId": "labs-order-123",
  "originStorefront": "vantalabsresearch.com",
  "transactionId": "1234567890",
  "amountCents": 12995,
  "currency": "USD"
}
```

### Response

- `200` when void succeeds with `paymentStatus: "voided"`
- `402` when void fails with `paymentStatus: "void_failed"`

## 8) Browser Tokenization Requirements (Vanta Labs checkout)

Card data must be tokenized by Authorize.net Accept.js before backend charge call.

Expected token payload:

```json
{
  "opaqueData": {
    "dataDescriptor": "...",
    "dataValue": "..."
  }
}
```

Never send raw PAN/CVV to Vanta Labs backend or Vanta Skin backend.

## 9) Supabase Integration Requirements

### On Vanta Skin side (already implemented)

- `payment_request_replays`: nonce replay lock
- `payment_idempotency`: request hash + stored response
- `payment_events`: transaction audit trail (includes origin storefront + payloads)
- `authnet_webhook_events`: webhook event ledger
  - includes `transaction_id`, `reconciled_order_id`, and `reconciled_status` for reconciliation traceability
- `payment_order_sync_events`: outbound callback outbox with delivery status, attempts, and errors

### For Vanta Labs side

When calling `charge/refund/void`, store and update in Labs DB:

- internal order id
- amount/currency sent
- idempotency key used
- returned `transactionId`
- returned `paymentStatus`
- raw bridge response body

On successful charge, update Labs order state to paid and continue existing fulfillment/email flow.

## 10) Vanta Skin → Vanta Labs callback contract (for reliable synchronization)

Vanta Skin sends payment status callbacks to `VANTA_LABS_SYNC_ENDPOINT_URL` (if configured).  
This is how webhook updates/refunds/voids are propagated back to Labs without making Vanta Skin an order system.

### Callback headers

- `content-type: application/json`
- `x-vanta-key-id`
- `x-vanta-timestamp`
- `x-vanta-nonce`
- `x-vanta-signature` (same canonical HMAC format)
- `x-idempotency-key` (set to callback `eventId`)

### Callback payload

```json
{
  "eventId": "bridge:charge:idem-123:labs-order-123:1234567890:captured",
  "source": "vanta-skin-payment-bridge",
  "action": "charge",
  "orderId": "labs-order-123",
  "originStorefront": "vantalabsresearch.com",
  "amountCents": 12995,
  "currency": "USD",
  "transactionId": "1234567890",
  "paymentStatus": "captured",
  "processorCode": "1",
  "message": "This transaction has been approved.",
  "sandbox": true,
  "occurredAt": "2026-10-16T00:00:00.000Z"
}
```

### Labs-side callback handling requirements

- Treat `eventId` as globally unique and idempotent.
- Keep a processed-events table keyed by `eventId`.
- If `eventId` already processed, return `200` and do nothing.
- Only Labs updates order paid/refund/void state and triggers fulfillment/email workflows.

### Retry behavior

- Vanta Skin records callback attempts in `payment_order_sync_events`.
- Failed deliveries remain pending/failed for retry.
- Ops can call `POST /api/payments/sync-retry` on Vanta Skin with:
  - header: `x-sync-retry-token: <VANTA_SYNC_RETRY_TOKEN>`

## 11) Sandbox Rollout Sequence

1. Keep all environments in sandbox mode.
2. Configure shared HMAC key/secret pair in both services.
3. Implement signing in Labs backend exactly as specified.
4. Tokenize in browser with Accept.js and send opaqueData to Labs backend.
5. Labs backend calls `/api/payments/charge` with headers + idempotency key.
6. Validate order/amount consistency in Labs before bridge call.
7. Run retries to verify idempotency behavior and nonce replay rejection.
8. Verify webhook events, callback deliveries, and retry behavior in Supabase.

## 12) Security/Compliance Notes

- Keep processor and Supabase secrets server-side only.
- Do not falsify product descriptions, storefront source, or order metadata.
- Preserve `originStorefront` and line-item visibility for processor/audit requirements.
- Do not switch to live processing until written approval and production sign-off.

## 13) Environment Variables (Vanta Skin)

Required:
- `AUTHNET_API_LOGIN_ID`
- `AUTHNET_TRANSACTION_KEY`
- `AUTHNET_CLIENT_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- One of:
  - `VANTA_HMAC_KEY_ID` + `VANTA_HMAC_SHARED_SECRET`
  - `VANTA_HMAC_KEYS_JSON`

Recommended:
- `AUTHNET_SIGNATURE_KEY` (for webhook signature verification)

Sandbox / policy controls:
- `AUTHNET_SANDBOX=true`
- `VANTA_ALLOWED_ORIGIN_STOREFRONTS=vantalabsresearch.com`

Sync callback controls:
- `VANTA_LABS_SYNC_ENDPOINT_URL`
- `VANTA_LABS_SYNC_KEY_ID`
- `VANTA_LABS_SYNC_SHARED_SECRET`
- `VANTA_LABS_PROTECTION_BYPASS` (Labs project's Vercel automation-bypass secret; previews only)
- `VANTA_SYNC_RETRY_TOKEN`

## Health check (no money moves)

`GET /api/payments/health`, signed exactly like the payment calls (same headers,
canonical message over an empty body). A `200` proves the caller's bridge secret
matches `VANTA_HMAC_SHARED_SECRET`; `401` means it does not.

`GET /api/payments/health?callback=1` also sends Labs a signed
`{ "type": "ping", "eventId": "ping:<uuid>", "challenge": "<hex>", "sandbox": <bool> }`
to `VANTA_LABS_SYNC_ENDPOINT_URL`. Labs answers `{ "pong": "<challenge>" }` only
after verifying the signature, so `checks.labsCallback = "verified"` proves both
copies of `VANTA_LABS_SYNC_SHARED_SECRET` match.

The response contains states only (`present`/`missing`, `reachable`/`error:<code>`,
`verified`/`failed:<status>`), never configuration values. Nonces are not stored;
nothing is written.
