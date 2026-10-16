const test = require('node:test');
const assert = require('node:assert/strict');
require('./support/fakes');
const {
  DUPLICATE_WINDOW_SECONDS,
  LIMITS,
  buildChargeRequest,
  buildRefundRequest,
  buildVoidRequest,
  invoiceNumberFor,
  refIdFor,
} = require('../api/_lib/authnet');
const { sha256Hex } = require('./support/fakes');

const config = { authnet: { apiLoginId: 'login', transactionKey: 'txkey', merchantDescriptor: 'Vanta Skin' } };

function fullPayload(overrides = {}) {
  return {
    orderId: 'order-2f5da385-b1b1-42be-a806-80adb74205f4',
    orderNumber: 'VL-10042',
    attemptNo: 2,
    originStorefront: 'vantalabsresearch.com',
    amountCents: 4604,
    currency: 'USD',
    capture: true,
    requireSandbox: true,
    opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'tok' },
    customer: { email: 'shopper@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '512-555-0100' },
    billTo: { firstName: 'Ada', lastName: 'Lovelace', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' },
    shippingCents: 995,
    taxCents: 125,
    lineItems: [{ sku: 'bpc-157', name: 'BPC-157 5mg Research Peptide', quantity: 1, unitPriceCents: 2999 }],
    customerIP: '203.0.113.9',
    ...overrides,
  };
}

// Compared as the JSON that goes on the wire (the SDK serialises with
// JSON.stringify), not as SDK class instances.
const wire = (request) => JSON.parse(JSON.stringify(request.getJSON()));

function build(payload, key = 'vskin:charge:order-2f5da385:2') {
  return wire(buildChargeRequest(config, payload, { refId: refIdFor(key) })).createTransactionRequest;
}

// The exact set of fields Authorize.Net receives for a charge, in schema
// order. Anything added here must be a deliberate decision.
test('charge request: exact field inventory', () => {
  const request = build(fullPayload());
  assert.deepEqual(Object.keys(request).filter((k) => request[k] !== null), ['merchantAuthentication', 'refId', 'transactionRequest']);

  const tx = request.transactionRequest;
  assert.deepEqual(Object.keys(tx), ['transactionType', 'amount', 'payment', 'order', 'lineItems', 'tax', 'shipping', 'customer', 'billTo', 'transactionSettings']);
  assert.deepEqual(Object.keys(tx.payment), ['opaqueData']);
  assert.deepEqual(Object.keys(tx.payment.opaqueData), ['dataDescriptor', 'dataValue']);
  assert.deepEqual(Object.keys(tx.order), ['invoiceNumber', 'description']);
  assert.deepEqual(tx.tax, { amount: '1.25', name: 'Tax' });
  assert.deepEqual(tx.shipping, { amount: '9.95', name: 'Shipping' });
  assert.deepEqual(tx.customer, { email: 'shopper@example.com' });
  assert.deepEqual(tx.billTo, {
    firstName: 'Ada', lastName: 'Lovelace', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US', phoneNumber: '512-555-0100',
  });
  assert.deepEqual(tx.transactionSettings, { setting: [{ settingName: 'duplicateWindow', settingValue: '120' }] });
  assert.equal(DUPLICATE_WINDOW_SECONDS, 120);

  assert.equal(tx.transactionType, 'authCaptureTransaction');
  assert.equal(tx.amount, '46.04');
});

// The real goods at their own prices are itemised for the processor and the
// customer's statement, per the written processing approval; the customer's
// IP address is never sent.
test('charge request: real line items are sent; no customer IP', () => {
  const tx = build(fullPayload()).transactionRequest;
  const text = JSON.stringify(tx);
  assert.equal(tx.customerIP, undefined);
  assert.equal(text.includes('203.0.113.9'), false);
  assert.equal(tx.lineItems.lineItem.length, 1);
  const line = tx.lineItems.lineItem[0];
  assert.equal(line.itemId, 'bpc-157');
  assert.equal(line.name, 'BPC-157 5mg Research Peptide');
  assert.equal(line.quantity, 1);
  assert.equal(line.unitPrice, '29.99');
});

test('charge request: description names the merchant of record and the true originating storefront', () => {
  const tx = build(fullPayload()).transactionRequest;
  assert.equal(tx.order.description, 'Vanta Skin | vantalabsresearch.com');
});

// The originating storefront and its order id must reach the processor
// unchanged on the charge. Refund and void carry only the masked card
// reference Authorize.Net requires — never a PAN.
test('processor requests preserve originating-storefront records', () => {
  const payload = fullPayload();
  const key = `vskin:charge:${payload.orderId}:2`;
  const charge = JSON.stringify(wire(buildChargeRequest(config, payload, { idempotencyKey: key })));
  assert.equal(charge.includes('vantalabsresearch.com'), true);
  assert.equal(charge.includes(payload.orderId.slice(0, 20)), true);
  assert.equal(charge.includes('BPC-157'), true);

  const reversals = [
    buildRefundRequest(config, { ...payload, transactionId: '60212345678', cardNumberMasked: '1111' }, { refId: refIdFor(key) }),
    buildVoidRequest(config, { ...payload, transactionId: '60212345678' }, { refId: refIdFor(key) }),
  ];
  for (const request of reversals) {
    const text = JSON.stringify(wire(request));
    assert.equal(text.includes('4111'), false);
    assert.equal(text.includes('XXXX1111'), text.includes('REFUND') || text.includes('refundTransaction'));
  }
});

test('charge request: refId is the first 20 hex chars of sha256(idempotency key)', () => {
  const key = 'vskin:charge:order-2f5da385:2';
  const request = build(fullPayload(), key);
  assert.equal(request.refId, sha256Hex(key).slice(0, 20));
  assert.equal(request.refId.length, 20);
  assert.equal(refIdFor(key), sha256Hex(key).slice(0, 20));
  // Passing the key instead of a precomputed refId gives the same value.
  const viaKey = wire(buildChargeRequest(config, fullPayload(), { idempotencyKey: key })).createTransactionRequest;
  assert.equal(viaKey.refId, request.refId);
});

// The invoice number is the originating storefront's order id (schema limit
// 20 chars), so Authorize.Net, the acquiring bank and the statement all
// reconcile against the same identifier. It is never rebranded or hashed.
test('charge request: invoice number is the storefront order id', () => {
  const invoice = build(fullPayload()).transactionRequest.order.invoiceNumber;
  assert.equal(invoice, fullPayload().orderId.slice(0, 20));
  assert.equal(invoice, invoiceNumberFor({ orderId: fullPayload().orderId }));
  assert.equal(invoice.length <= LIMITS.invoiceNumber, true);
  assert.equal(invoiceNumberFor({ orderId: 'order-abc' }), 'order-abc');
  assert.notEqual(invoice, invoiceNumberFor({ orderId: 'order-abc' }));
});

test('charge request: minimal payload sends only the required fields', () => {
  const tx = build(fullPayload({ customer: undefined, billTo: undefined, shippingCents: 0, taxCents: 0, lineItems: undefined })).transactionRequest;
  assert.deepEqual(Object.keys(tx), ['transactionType', 'amount', 'payment', 'order', 'transactionSettings']);
});

test('charge request: email only → customer only; phone only → billTo.phoneNumber only', () => {
  const emailOnly = build(fullPayload({ billTo: undefined, customer: { email: 'a@b.co' } })).transactionRequest;
  assert.deepEqual(emailOnly.customer, { email: 'a@b.co' });
  assert.equal(emailOnly.billTo, undefined);

  const phoneOnly = build(fullPayload({ billTo: undefined, customer: { phone: '5125550100' } })).transactionRequest;
  assert.equal(phoneOnly.customer, undefined);
  assert.deepEqual(phoneOnly.billTo, { phoneNumber: '5125550100' });
});

test('charge request: billTo fields are truncated to Authorize.Net limits and empties omitted', () => {
  const long = (n) => 'x'.repeat(n + 10);
  const tx = build(fullPayload({
    customer: { email: 'a@b.co', phone: '9'.repeat(40) },
    billTo: {
      firstName: long(50), lastName: long(50), address: long(60), city: long(40), state: long(40), zip: long(20), country: long(60),
    },
  })).transactionRequest;
  assert.equal(tx.billTo.firstName.length, LIMITS.firstName);
  assert.equal(tx.billTo.lastName.length, LIMITS.lastName);
  assert.equal(tx.billTo.address.length, LIMITS.address);
  assert.equal(tx.billTo.city.length, LIMITS.city);
  assert.equal(tx.billTo.state.length, LIMITS.state);
  assert.equal(tx.billTo.zip.length, LIMITS.zip);
  assert.equal(tx.billTo.country.length, LIMITS.country);
  assert.equal(tx.billTo.phoneNumber.length, LIMITS.phoneNumber);
  assert.deepEqual([LIMITS.firstName, LIMITS.lastName, LIMITS.address, LIMITS.city, LIMITS.state, LIMITS.zip, LIMITS.country, LIMITS.phoneNumber], [50, 50, 60, 40, 40, 20, 60, 25]);

  const sparse = build(fullPayload({ billTo: { firstName: '  ', city: 'Austin', zip: '' } })).transactionRequest;
  assert.deepEqual(sparse.billTo, { city: 'Austin', phoneNumber: '512-555-0100' });
});

test('charge request: always authCaptureTransaction', () => {
  assert.equal(build(fullPayload({ capture: undefined })).transactionRequest.transactionType, 'authCaptureTransaction');
});

test('refund request: exact field inventory (masked card, XXXX expiry, refTransId)', () => {
  const request = wire(buildRefundRequest(config, { amountCents: 1500, cardNumberMasked: '1111', transactionId: '60212345678', expirationDate: '1229' }, { refId: 'r'.repeat(20) }))
    .createTransactionRequest;
  assert.equal(request.refId, 'r'.repeat(20));
  assert.deepEqual(request.transactionRequest, {
    transactionType: 'refundTransaction',
    amount: '15.00',
    payment: { creditCard: { cardNumber: 'XXXX1111', expirationDate: 'XXXX' } },
    refTransId: '60212345678',
  });
});

test('void request: exact field inventory', () => {
  const request = wire(buildVoidRequest(config, { transactionId: '60212345678' }, { refId: 'v'.repeat(20) })).createTransactionRequest;
  assert.equal(request.refId, 'v'.repeat(20));
  assert.deepEqual(request.transactionRequest, { transactionType: 'voidTransaction', refTransId: '60212345678' });
});

// Issuer authentication (3-D Secure). Accept.js has no 3-D Secure, and the
// API's cardholderAuthentication element is deprecated by Authorize.Net and
// usable only with a separate third-party authentication provider, which this
// account does not have. So no authentication values are invented or sent; a
// bank that wants verification simply declines, and the customer is told so.
test('the charge carries no cardholder-authentication (3-D Secure) values', () => {
  const json = JSON.stringify(wire(buildChargeRequest(config, fullPayload(), { refId: 'r' })));
  assert.doesNotMatch(json, /cardholderAuthentication|authenticationIndicator|cardholderAuthenticationValue/);
});
