# Vanta Labs → Vanta Skin Payment Bridge Handoff (Sandbox First)

This document defines the exact integration contract for the Vanta Labs backend to call the Vanta Skin payment service.

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

## 3) Required Headers (Vanta Labs backend → Vanta Skin backend)

- `content-type: application/json`
- `x-vanta-key-id: <key id>`
- `x-vanta-timestamp: <unix-seconds>`
- `x-vanta-nonce: <unique random nonce per request>`
- `x-vanta-signature: <hex hmac sha256>`
- `x-idempotency-key: <unique key per operation intent>`

### Replay and idempotency rules

- Reusing the same `(x-vanta-key-id, x-vanta-nonce)` is rejected (`409`).
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

`cardNumberMasked` should be the required refund card reference accepted by Authorize.net for prior transactions.

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

### For Vanta Labs side

When calling `charge/refund/void`, store and update in Labs DB:

- internal order id
- amount/currency sent
- idempotency key used
- returned `transactionId`
- returned `paymentStatus`
- raw bridge response body

On successful charge, update Labs order state to paid and continue existing fulfillment/email flow.

## 10) Sandbox Rollout Sequence

1. Keep all environments in sandbox mode.
2. Configure shared HMAC key/secret pair in both services.
3. Implement signing in Labs backend exactly as specified.
4. Tokenize in browser with Accept.js and send opaqueData to Labs backend.
5. Labs backend calls `/api/payments/charge` with headers + idempotency key.
6. Validate order/amount consistency in Labs before bridge call.
7. Run retries to verify idempotency behavior and nonce replay rejection.
8. Verify webhook events and payment audit logs in Supabase.

## 11) Security/Compliance Notes

- Keep processor and Supabase secrets server-side only.
- Do not falsify product descriptions, storefront source, or order metadata.
- Preserve `originStorefront` and line-item visibility for processor/audit requirements.
- Do not switch to live processing until written approval and production sign-off.
