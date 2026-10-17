# Payment page — PCI DSS v4.0.1 notes (engineering view)

This records what the code does for the payment-page requirements, and what
it cannot do. **It is not a PCI assessment.** The applicable Self-Assessment
Questionnaire (SAQ) and whether a control is "in place" are decided by the
merchant with the acquirer/processor and, where required, a QSA. Nothing here
claims compliance or a final SAQ type.

## How card data moves

| Step | Where | Card data present? |
|---|---|---|
| Shopper types the card | Skin-hosted iframe `GET /api/payments/embed` (Skin origin), framed by the Labs pay page | Yes, in the iframe's DOM only |
| Tokenisation | Accept.js (`js.authorize.net` / `jstest.authorize.net`) loaded **inside the iframe**, posting directly from the browser to Authorize.Net | Yes, browser → Authorize.Net |
| Token hand-off | iframe → Labs page (`postMessage`, exact origin + window) → Labs server → Skin server (HMAC) | No: `opaqueData` token only |
| Charge | Skin server → Authorize.Net API | No: token only |

No server of Labs or Skin receives, logs or stores a card number, CVV or
expiry. Stored request payloads replace the token and the session token with
`[redacted]`. The Labs page never sees the card fields (cross-origin frame).

Because the merchant's own page (the Skin iframe) hosts the fields and loads
Accept.js, this is the "merchant page with a direct-post/JavaScript
tokeniser" pattern. Processors commonly map that to **SAQ A-EP** rather than
SAQ A (which fits a fully outsourced hosted page or iframe served by the
processor itself, e.g. Authorize.Net Accept Hosted). Confirm with the
processor.

## Requirement 6.4.3 — payment-page scripts authorised, integrity-assured, inventoried

Skin iframe (where the card is entered), enforced in code:

- `Content-Security-Policy` on `/api/payments/embed`:
  `default-src 'none'`; `script-src` = SHA-256 hash of the one inline script +
  `https://jstest.authorize.net https://js.authorize.net` only; `style-src` =
  hash of the one inline style; `connect-src 'self'` + the Authorize.Net
  js/api hosts; `img-src`/`font-src 'none'`; `base-uri 'none'`;
  `form-action 'self'`; `frame-ancestors` = the approved Labs origins.
- Inventory: exactly two scripts — the inline bootstrap (`EMBED_SCRIPT`,
  hash-pinned, changes only via a reviewed commit) and Accept.js.
- Integrity: the inline script by CSP hash. Accept.js is served by
  Authorize.Net without a published SRI hash (Authorize.Net documents that it
  self-verifies its core library); its integrity rests on the CSP host
  allowlist and TLS. Record that justification in the 6.4.3 inventory.

Labs pay page (the page that frames the card form):

- Enforced site-wide (`middleware.ts`): `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`, `form-action`, `upgrade-insecure-requests`,
  `X-Frame-Options: DENY`.
- `/checkout/pay/*` additionally sends `Content-Security-Policy-Report-Only`
  with the authorised script and frame hosts (`lib/payment-page-csp.ts`) and
  reports anything else to Sentry. It is report-only because the same page
  serves Vera, whose 3-D Secure frames can come from any card issuer.
- Whether the parent page is in scope for 6.4.3/11.6.1 depends on the SAQ and
  current PCI SSC guidance for embedded payment forms. Treat it as in scope
  until the processor/QSA says otherwise.

## Requirement 11.6.1 — detect unauthorised changes to the payment page

- In code: the iframe's inline script and style are hash-pinned in its CSP,
  so any change that is not shipped with a matching policy fails to execute.
  `test/embed-endpoints.test.js` and `test/embed-script.test.js` pin the CSP
  and the script's behaviour; a change shows up as a reviewed diff.
- Labs pay page: report-only CSP violations go to Sentry; set a Sentry alert
  on them.
- **Not provided by the code:** a weekly (or risk-based) check of the *live*
  payment page's headers and scripts as the browser receives them. That needs
  a monitoring tool or a scheduled synthetic check, an owner, and an alert
  route. Merchant/hosting decision.

## Other items that need the merchant, hosting provider or QSA

- Confirm the SAQ type and complete it; keep the 6.4.3 script inventory with
  justifications.
- Vercel (hosting) and Supabase (databases) responsibility matrices / AOCs for
  the components in scope.
- Access control and MFA for the Vercel, Supabase, GitHub and Authorize.Net
  accounts; key rotation (bridge HMAC secrets, Authorize.Net transaction and
  signature keys) and who may change them.
- Authorize.Net account settings that affect security: Transaction Details
  API enabled (needed for reconciliation), fraud filters, the account's
  website setting and statement descriptor.
- Incident response if a script or key is ever suspected compromised.
