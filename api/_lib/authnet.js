const { createHash } = require('node:crypto');
const { APIContracts, APIControllers, Constants } = require('authorizenet');

// ---------------------------------------------------------------------------
// Field limits (Authorize.Net XML schema / API reference).
// ---------------------------------------------------------------------------
const LIMITS = Object.freeze({
  refId: 20,
  invoiceNumber: 20,
  description: 255,
  email: 255,
  firstName: 50,
  lastName: 50,
  address: 60,
  city: 40,
  state: 40,
  zip: 20,
  country: 60,
  phoneNumber: 25,
});

// Seconds within which Authorize.Net rejects an identical transaction
// (same amount, card, invoice number) as a duplicate. A backstop behind our
// own idempotency keys.
const DUPLICATE_WINDOW_SECONDS = 120;

// The only storefront domain Authorize.Net ever sees in order.description.
const STOREFRONT_DOMAIN = 'vanta.skin';

class GatewayTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Authorize.Net did not answer within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class GatewayNetworkError extends Error {
  constructor(cause) {
    super('Authorize.Net request failed before a response was received');
    this.name = 'GatewayNetworkError';
    this.causeCode = cause?.code || null;
  }
}

class GatewayLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayLookupError';
  }
}

function moneyFromCents(value) {
  return (Number(value) / 100).toFixed(2);
}

function centsFromMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Trim, drop control characters, cut to the gateway's limit. Non-strings and
// empty strings become null, so the field is left out of the request.
function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function refIdFor(idempotencyKey) {
  return createHash('sha256').update(String(idempotencyKey || ''), 'utf8').digest('hex').slice(0, LIMITS.refId);
}

// The storefront's order number when it fits Authorize.Net's 20 characters,
// else the first 20 characters of the order id. Labs computes the same value
// for reconciliation, so it must stay deterministic.
function invoiceNumberFor(payload) {
  const orderNumber = typeof payload?.orderNumber === 'string' ? payload.orderNumber.trim() : '';
  if (orderNumber && orderNumber.length <= LIMITS.invoiceNumber) return orderNumber;
  return String(payload?.orderId || '').slice(0, LIMITS.invoiceNumber);
}

function normalizeRefundCardReference(value) {
  const raw = String(value || '').trim().replace(/\s+/g, '');
  if (/^\d{4}$/.test(raw)) return `XXXX${raw}`;
  if (/^X{4}\d{4}$/i.test(raw)) return raw.toUpperCase();
  throw new Error('cardNumberMasked must be the last 4 digits of the card');
}

function merchantAuth(config) {
  const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
  merchantAuthenticationType.setName(config.authnet.apiLoginId);
  merchantAuthenticationType.setTransactionKey(config.authnet.transactionKey);
  return merchantAuthenticationType;
}

function extendedAmount(cents, name) {
  const amount = new APIContracts.ExtendedAmountType();
  amount.setAmount(moneyFromCents(cents));
  amount.setName(name);
  return amount;
}

function buildBillTo(payload) {
  const source = payload?.billTo && typeof payload.billTo === 'object' ? payload.billTo : {};
  const fields = {
    firstName: cleanText(source.firstName, LIMITS.firstName),
    lastName: cleanText(source.lastName, LIMITS.lastName),
    address: cleanText(source.address, LIMITS.address),
    city: cleanText(source.city, LIMITS.city),
    state: cleanText(source.state, LIMITS.state),
    zip: cleanText(source.zip, LIMITS.zip),
    country: cleanText(source.country, LIMITS.country),
    phoneNumber: cleanText(payload?.customer?.phone, LIMITS.phoneNumber),
  };
  if (!Object.values(fields).some(Boolean)) return null;

  const billTo = new APIContracts.CustomerAddressType();
  if (fields.firstName) billTo.setFirstName(fields.firstName);
  if (fields.lastName) billTo.setLastName(fields.lastName);
  if (fields.address) billTo.setAddress(fields.address);
  if (fields.city) billTo.setCity(fields.city);
  if (fields.state) billTo.setState(fields.state);
  if (fields.zip) billTo.setZip(fields.zip);
  if (fields.country) billTo.setCountry(fields.country);
  if (fields.phoneNumber) billTo.setPhoneNumber(fields.phoneNumber);
  return billTo;
}

function createTransactionRequest(config, transactionRequestType, refId) {
  const request = new APIContracts.CreateTransactionRequest();
  request.setMerchantAuthentication(merchantAuth(config));
  if (refId) request.setRefId(String(refId).slice(0, LIMITS.refId));
  request.setTransactionRequest(transactionRequestType);
  return request;
}

// What Authorize.Net receives for a charge, and nothing else:
//   refId, transactionType, amount, payment.opaqueData, order.invoiceNumber,
//   order.description, tax / shipping (when > 0), customer.email (when given),
//   billTo (when given), transactionSettings.duplicateWindow.
// No line items, no product names, no customer IP. The description always
// names vanta.skin — the originating storefront is never sent.
function buildChargeRequest(config, payload, { refId, idempotencyKey } = {}) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);
  transactionRequestType.setAmount(moneyFromCents(payload.amountCents));

  const opaqueData = new APIContracts.OpaqueDataType();
  opaqueData.setDataDescriptor(payload.opaqueData.dataDescriptor);
  opaqueData.setDataValue(payload.opaqueData.dataValue);
  const paymentType = new APIContracts.PaymentType();
  paymentType.setOpaqueData(opaqueData);
  transactionRequestType.setPayment(paymentType);

  const order = new APIContracts.OrderType();
  order.setInvoiceNumber(invoiceNumberFor(payload));
  order.setDescription(`${config.authnet.merchantDescriptor} | ${STOREFRONT_DOMAIN}`.slice(0, LIMITS.description));
  transactionRequestType.setOrder(order);

  if (Number.isInteger(payload.taxCents) && payload.taxCents > 0) {
    transactionRequestType.setTax(extendedAmount(payload.taxCents, 'Tax'));
  }
  if (Number.isInteger(payload.shippingCents) && payload.shippingCents > 0) {
    transactionRequestType.setShipping(extendedAmount(payload.shippingCents, 'Shipping'));
  }

  const email = cleanText(payload?.customer?.email, LIMITS.email);
  if (email) {
    const customer = new APIContracts.CustomerDataType();
    customer.setEmail(email);
    transactionRequestType.setCustomer(customer);
  }

  const billTo = buildBillTo(payload);
  if (billTo) transactionRequestType.setBillTo(billTo);

  const setting = new APIContracts.SettingType();
  setting.setSettingName('duplicateWindow');
  setting.setSettingValue(String(DUPLICATE_WINDOW_SECONDS));
  const settings = new APIContracts.ArrayOfSetting();
  settings.setSetting([setting]);
  transactionRequestType.setTransactionSettings(settings);

  return createTransactionRequest(config, transactionRequestType, refId || (idempotencyKey ? refIdFor(idempotencyKey) : null));
}

// Refund: refId, transactionType, amount, payment.creditCard (XXXX#### and
// expiration XXXX — the masked reference Authorize.Net requires), refTransId.
function buildRefundRequest(config, payload, { refId } = {}) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.REFUNDTRANSACTION);
  transactionRequestType.setAmount(moneyFromCents(payload.amountCents));

  const card = new APIContracts.CreditCardType();
  card.setCardNumber(normalizeRefundCardReference(payload.cardNumberMasked));
  card.setExpirationDate('XXXX');
  const payment = new APIContracts.PaymentType();
  payment.setCreditCard(card);
  transactionRequestType.setPayment(payment);
  transactionRequestType.setRefTransId(String(payload.transactionId));

  return createTransactionRequest(config, transactionRequestType, refId);
}

// Void: refId, transactionType, refTransId.
function buildVoidRequest(config, payload, { refId } = {}) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.VOIDTRANSACTION);
  transactionRequestType.setRefTransId(String(payload.transactionId));
  return createTransactionRequest(config, transactionRequestType, refId);
}

// ---------------------------------------------------------------------------
// Executing requests.
// ---------------------------------------------------------------------------

function parseSdkResponse(response) {
  if (response === undefined || response === null || response === '') return null;
  if (typeof response === 'string') return JSON.parse(response.replace(/^﻿/, ''));
  return response;
}

// Adapter over the SDK controllers. The SDK resolves only on success: on a
// network error it records the error and never calls back, which is why every
// call goes through withTimeout, and why the controller's error slot is polled.
function createSdkExecutor({ controllers = APIControllers, endpoints = Constants.endpoint, pollMs = 250 } = {}) {
  return function sdkExecute(requestJson, { controller, sandbox }) {
    return new Promise((resolve, reject) => {
      const Ctor = controllers[controller];
      if (!Ctor) {
        reject(new Error(`Unknown Authorize.Net controller ${controller}`));
        return;
      }
      const ctrl = new Ctor(requestJson);
      ctrl.setEnvironment(sandbox ? endpoints.sandbox : endpoints.production);
      let settled = false;
      const poll = setInterval(() => {
        const error = typeof ctrl.getError === 'function' ? ctrl.getError() : null;
        if (error && !settled) {
          settled = true;
          clearInterval(poll);
          reject(new GatewayNetworkError(error));
        }
      }, pollMs);
      if (typeof poll.unref === 'function') poll.unref();
      ctrl.execute(() => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        try {
          resolve(parseSdkResponse(ctrl.getResponse()));
        } catch (error) {
          reject(error);
        }
      });
    });
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GatewayTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Mapping responses to outcomes.
// ---------------------------------------------------------------------------

function mapMessage(response) {
  const direct = response?.messages?.message?.[0];
  const tx = response?.transactionResponse;
  const txErr = tx?.errors?.[0];
  const txMsg = tx?.messages?.[0];
  return txErr?.errorText || txMsg?.description || direct?.text || 'Payment processor error';
}

function cardLast4From(accountNumber) {
  const match = String(accountNumber || '').match(/(\d{4})\s*$/);
  return match ? match[1] : null;
}

function cleanTransId(value) {
  const id = value === undefined || value === null ? '' : String(value).trim();
  return id && id !== '0' ? id : null;
}

// responseCode "1" + transId → captured; "2" → declined; "3" → rejected;
// "4" → held. An API-level Error with no transactionResponse was refused
// before processing → rejected. Anything else → uncertain: it is never safe
// to call an unknown answer a decline.
function mapGatewayResponse(response) {
  if (!response || typeof response !== 'object') {
    return uncertainResult('no_response');
  }
  const tx = response.transactionResponse;
  const resultCode = response?.messages?.resultCode || null;
  const transactionId = cleanTransId(tx?.transId);
  const base = {
    transactionId,
    authCode: tx?.authCode ? String(tx.authCode) : null,
    cardLast4: cardLast4From(tx?.accountNumber),
    cardType: tx?.accountType ? String(tx.accountType) : null,
    processorCode: tx?.responseCode ? String(tx.responseCode) : resultCode,
    errorCode: tx?.errors?.[0]?.errorCode || response?.messages?.message?.[0]?.code || null,
    message: mapMessage(response),
    gatewayRefId: response.refId || null,
    raw: response,
  };

  if (!tx) {
    if (resultCode === 'Error') return { ...base, outcome: 'rejected' };
    return { ...base, outcome: 'uncertain', reason: 'no_transaction_response' };
  }

  switch (String(tx.responseCode || '')) {
    case '1':
      return transactionId ? { ...base, outcome: 'captured' } : { ...base, outcome: 'uncertain', reason: 'approved_without_transaction_id' };
    case '2':
      return { ...base, outcome: 'declined' };
    case '3':
      return { ...base, outcome: 'rejected' };
    case '4':
      return { ...base, outcome: 'held' };
    default:
      return { ...base, outcome: 'uncertain', reason: 'unknown_response_code' };
  }
}

function uncertainResult(reason, error) {
  return {
    outcome: 'uncertain',
    reason,
    errorName: error?.name || null,
    transactionId: null,
    authCode: null,
    cardLast4: null,
    cardType: null,
    processorCode: null,
    errorCode: null,
    message: reason === 'timeout' ? 'Gateway timeout' : 'Gateway result unknown',
    gatewayRefId: null,
    raw: null,
  };
}

// ---------------------------------------------------------------------------
// Lookups for reconciliation (read-only, no money moves).
// ---------------------------------------------------------------------------

function listOf(container, key) {
  if (!container) return [];
  if (Array.isArray(container)) return container;
  const inner = container[key];
  if (Array.isArray(inner)) return inner;
  return inner ? [inner] : [];
}

function assertLookupOk(response, what) {
  if (!response) throw new GatewayLookupError(`${what}: empty response`);
  if (response?.messages?.resultCode === 'Error') {
    const code = response?.messages?.message?.[0]?.code || 'unknown';
    throw new GatewayLookupError(`${what}: ${code}`);
  }
  return response;
}

function isoSeconds(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sortingNewestFirst() {
  const sorting = new APIContracts.TransactionListSorting();
  sorting.setOrderBy(APIContracts.TransactionListOrderFieldEnum.SUBMITTIMEUTC);
  sorting.setOrderDescending(true);
  return sorting;
}

function paging(limit = 1000, offset = 1) {
  const p = new APIContracts.Paging();
  p.setLimit(limit);
  p.setOffset(offset);
  return p;
}

// ---------------------------------------------------------------------------
// Gateway client. Everything that reaches the network goes through `execute`,
// which tests replace; the default is the real SDK.
// ---------------------------------------------------------------------------

let defaultExecutor = null;

function getDefaultExecutor() {
  if (!defaultExecutor) defaultExecutor = createSdkExecutor();
  return defaultExecutor;
}

// Tests install an executor that throws, so no test can reach the real SDK.
function setDefaultExecutor(fn) {
  defaultExecutor = fn;
}

function createGateway({ execute, timeoutMs } = {}) {
  const run = (config, requestObject, controller) => {
    const exec = execute || getDefaultExecutor();
    const ms = timeoutMs || config?.authnet?.timeoutMs || 20000;
    return withTimeout(exec(requestObject.getJSON(), { controller, sandbox: config.authnet.sandbox !== false }), ms);
  };

  async function transact(config, requestObject, refId) {
    let response;
    try {
      response = await run(config, requestObject, 'CreateTransactionController');
    } catch (error) {
      return { ...uncertainResult(error instanceof GatewayTimeoutError ? 'timeout' : 'gateway_error', error), refId };
    }
    return { ...mapGatewayResponse(response), refId };
  }

  return {
    charge(config, payload, { refId } = {}) {
      return transact(config, buildChargeRequest(config, payload, { refId }), refId);
    },
    refund(config, payload, { refId } = {}) {
      return transact(config, buildRefundRequest(config, payload, { refId }), refId);
    },
    void(config, payload, { refId } = {}) {
      return transact(config, buildVoidRequest(config, payload, { refId }), refId);
    },

    async getUnsettledTransactionList(config) {
      const request = new APIContracts.GetUnsettledTransactionListRequest();
      request.setMerchantAuthentication(merchantAuth(config));
      request.setSorting(sortingNewestFirst());
      request.setPaging(paging());
      const response = assertLookupOk(await run(config, request, 'GetUnsettledTransactionListController'), 'getUnsettledTransactionList');
      return listOf(response.transactions, 'transaction');
    },

    async getSettledBatchList(config, { from, to }) {
      const request = new APIContracts.GetSettledBatchListRequest();
      request.setMerchantAuthentication(merchantAuth(config));
      request.setIncludeStatistics(false);
      request.setFirstSettlementDate(isoSeconds(from));
      request.setLastSettlementDate(isoSeconds(to));
      const response = assertLookupOk(await run(config, request, 'GetSettledBatchListController'), 'getSettledBatchList');
      return listOf(response.batchList, 'batch');
    },

    async getTransactionList(config, batchId) {
      const request = new APIContracts.GetTransactionListRequest();
      request.setMerchantAuthentication(merchantAuth(config));
      request.setBatchId(String(batchId));
      request.setSorting(sortingNewestFirst());
      request.setPaging(paging());
      const response = assertLookupOk(await run(config, request, 'GetTransactionListController'), 'getTransactionList');
      return listOf(response.transactions, 'transaction');
    },

    async getTransactionDetails(config, transId) {
      const request = new APIContracts.GetTransactionDetailsRequest();
      request.setMerchantAuthentication(merchantAuth(config));
      request.setTransId(String(transId));
      const response = assertLookupOk(await run(config, request, 'GetTransactionDetailsController'), 'getTransactionDetails');
      return response.transaction || null;
    },

    // Settled transactions from batches settled in the last `days` days.
    async getRecentSettledTransactions(config, { now = new Date(), days = 2 } = {}) {
      const to = new Date(now);
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      const batches = await this.getSettledBatchList(config, { from, to });
      const all = [];
      for (const batch of batches) {
        if (!batch?.batchId) continue;
        const txs = await this.getTransactionList(config, batch.batchId);
        all.push(...txs);
      }
      return all;
    },
  };
}

// Back-compat helpers for callers that do not inject a gateway.
function chargeOpaqueData(config, payload, opts) {
  return createGateway().charge(config, payload, opts);
}
function refundTransaction(config, payload, opts) {
  return createGateway().refund(config, payload, opts);
}
function voidTransaction(config, payload, opts) {
  return createGateway().void(config, typeof payload === 'object' ? payload : { transactionId: payload }, opts);
}

module.exports = {
  DUPLICATE_WINDOW_SECONDS,
  GatewayLookupError,
  GatewayNetworkError,
  GatewayTimeoutError,
  LIMITS,
  buildChargeRequest,
  buildRefundRequest,
  buildVoidRequest,
  cardLast4From,
  centsFromMoney,
  chargeOpaqueData,
  createGateway,
  createSdkExecutor,
  invoiceNumberFor,
  mapGatewayResponse,
  moneyFromCents,
  normalizeRefundCardReference,
  parseSdkResponse,
  refIdFor,
  refundTransaction,
  setDefaultExecutor,
  voidTransaction,
  withTimeout,
};
