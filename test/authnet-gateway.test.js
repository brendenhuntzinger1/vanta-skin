const test = require('node:test');
const assert = require('node:assert/strict');
require('./support/fakes');
const {
  GatewayLookupError,
  GatewayNetworkError,
  GatewayTimeoutError,
  createGateway,
  createSdkExecutor,
  mapGatewayResponse,
  withTimeout,
} = require('../api/_lib/authnet');

const config = { authnet: { apiLoginId: 'l', transactionKey: 't', merchantDescriptor: 'Vanta Skin', sandbox: true, timeoutMs: 20000 } };
const payload = {
  orderId: 'order-1', originStorefront: 'vantalabsresearch.com', amountCents: 4604,
  opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'tok' },
};

function txResponse(tx, resultCode = 'Ok') {
  return { refId: 'r', messages: { resultCode, message: [{ code: resultCode === 'Ok' ? 'I00001' : 'E00027', text: 'x' }] }, transactionResponse: tx };
}

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

test('responseCode 1 with transId → captured, with card last 4 and type', () => {
  const r = mapGatewayResponse(txResponse({ responseCode: '1', transId: '6001', authCode: 'ABC123', accountNumber: 'XXXX1111', accountType: 'Visa', messages: [{ code: '1', description: 'This transaction has been approved.' }] }));
  assert.equal(r.outcome, 'captured');
  assert.equal(r.transactionId, '6001');
  assert.equal(r.authCode, 'ABC123');
  assert.equal(r.cardLast4, '1111');
  assert.equal(r.cardType, 'Visa');
  assert.equal(r.processorCode, '1');
  assert.equal(r.message, 'This transaction has been approved.');
});

test('responseCode 1 without a transId is not called captured', () => {
  assert.equal(mapGatewayResponse(txResponse({ responseCode: '1', transId: '0' })).outcome, 'uncertain');
});

test('responseCode 2 → declined, 3 → rejected, 4 → held', () => {
  assert.equal(mapGatewayResponse(txResponse({ responseCode: '2', transId: '6002', accountNumber: 'XXXX0002' })).outcome, 'declined');
  const rejected = mapGatewayResponse(txResponse({ responseCode: '3', transId: '0', errors: [{ errorCode: '11', errorText: 'A duplicate transaction has been submitted.' }] }, 'Error'));
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.transactionId, null);
  assert.equal(rejected.errorCode, '11');
  assert.equal(mapGatewayResponse(txResponse({ responseCode: '4', transId: '6004' })).outcome, 'held');
});

test('API Error with no transactionResponse → rejected (not charged)', () => {
  const r = mapGatewayResponse({ messages: { resultCode: 'Error', message: [{ code: 'E00007', text: 'User authentication failed due to invalid authentication values.' }] } });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.processorCode, 'Error');
});

test('no response, unknown responseCode or Ok without transactionResponse → uncertain', () => {
  assert.equal(mapGatewayResponse(null).outcome, 'uncertain');
  assert.equal(mapGatewayResponse(undefined).outcome, 'uncertain');
  assert.equal(mapGatewayResponse(txResponse({ responseCode: '9', transId: '1' })).outcome, 'uncertain');
  assert.equal(mapGatewayResponse({ messages: { resultCode: 'Ok' } }).outcome, 'uncertain');
});

// ---------------------------------------------------------------------------
// Timeout and the SDK adapter
// ---------------------------------------------------------------------------

test('withTimeout rejects with GatewayTimeoutError', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), (err) => err instanceof GatewayTimeoutError && err.name === 'GatewayTimeoutError');
});

test('a gateway that never answers → charge resolves uncertain (timeout), never declined', async () => {
  const gateway = createGateway({ execute: () => new Promise(() => {}), timeoutMs: 20 });
  const result = await gateway.charge(config, payload, { refId: 'r1' });
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.refId, 'r1');
});

test('a gateway that throws → uncertain', async () => {
  const gateway = createGateway({ execute: async () => { throw new Error('ECONNRESET'); } });
  const result = await gateway.charge(config, payload, { refId: 'r1' });
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.reason, 'gateway_error');
});

test('the default executor is disabled in tests (no real SDK network)', async () => {
  const result = await createGateway().charge(config, payload, { refId: 'r1' });
  assert.equal(result.outcome, 'uncertain');
});

test('the gateway passes the request JSON, controller and sandbox flag to execute', async () => {
  const seen = [];
  const gateway = createGateway({
    execute: async (json, opts) => {
      seen.push({ json, opts });
      return txResponse({ responseCode: '1', transId: '6001', accountNumber: 'XXXX4242', accountType: 'MasterCard' });
    },
  });
  const result = await gateway.charge(config, payload, { refId: 'abcdefabcdefabcdefab' });
  assert.equal(result.outcome, 'captured');
  assert.equal(result.cardLast4, '4242');
  assert.equal(seen[0].opts.controller, 'CreateTransactionController');
  assert.equal(seen[0].opts.sandbox, true);
  assert.equal(seen[0].json.createTransactionRequest.refId, 'abcdefabcdefabcdefab');
});

function fakeControllers(behaviour) {
  class Fake {
    constructor(json) {
      this.json = json;
      this._error = null;
    }
    setEnvironment(env) { this.env = env; }
    getError() { return this._error; }
    getResponse() { return this._response; }
    execute(cb) { behaviour(this, cb); }
  }
  return { CreateTransactionController: Fake };
}

const endpoints = { sandbox: 'https://sandbox.test', production: 'https://prod.test' };

test('SDK adapter: an already-parsed response object resolves (old code JSON.parsed it and hung)', async () => {
  const exec = createSdkExecutor({ endpoints, controllers: fakeControllers((ctrl, cb) => { ctrl._response = { messages: { resultCode: 'Ok' }, transactionResponse: { responseCode: '1', transId: '7' } }; cb(); }) });
  const response = await exec({}, { controller: 'CreateTransactionController', sandbox: true });
  assert.equal(response.transactionResponse.transId, '7');
});

test('SDK adapter: a string response with a BOM is parsed', async () => {
  const exec = createSdkExecutor({ endpoints, controllers: fakeControllers((ctrl, cb) => { ctrl._response = '﻿{"messages":{"resultCode":"Ok"}}'; cb(); }) });
  const response = await exec({}, { controller: 'CreateTransactionController', sandbox: true });
  assert.equal(response.messages.resultCode, 'Ok');
});

test('SDK adapter: picks the sandbox endpoint unless sandbox is false', async () => {
  let env;
  const exec = createSdkExecutor({ endpoints, controllers: fakeControllers((ctrl, cb) => { env = ctrl.env; ctrl._response = {}; cb(); }) });
  await exec({}, { controller: 'CreateTransactionController', sandbox: true });
  assert.equal(env, 'https://sandbox.test');
  await exec({}, { controller: 'CreateTransactionController', sandbox: false });
  assert.equal(env, 'https://prod.test');
});

test('SDK adapter: a network error the SDK swallows is surfaced (GatewayNetworkError)', async () => {
  const exec = createSdkExecutor({ endpoints, pollMs: 5, controllers: fakeControllers((ctrl) => { ctrl._error = { code: 'ECONNRESET' }; }) });
  // withTimeout keeps the event loop alive (the poll timer is unref'd; in
  // production the SDK's socket does that).
  await assert.rejects(withTimeout(exec({}, { controller: 'CreateTransactionController', sandbox: true }), 1000), (err) => err instanceof GatewayNetworkError);
});

test('SDK adapter: an SDK that never calls back is cut off by our timeout', async () => {
  const exec = createSdkExecutor({ endpoints, controllers: fakeControllers(() => {}) });
  const gateway = createGateway({ execute: exec, timeoutMs: 20 });
  const result = await gateway.charge(config, payload, { refId: 'r' });
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.reason, 'timeout');
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test('lookups go through the injected executor with the right controllers and shapes', async () => {
  const seen = [];
  const gateway = createGateway({
    execute: async (json, { controller }) => {
      seen.push({ controller, json });
      if (controller === 'GetUnsettledTransactionListController') return { messages: { resultCode: 'Ok' }, transactions: [{ transId: '1' }, { transId: '2' }] };
      if (controller === 'GetSettledBatchListController') return { messages: { resultCode: 'Ok' }, batchList: { batch: [{ batchId: 'b1' }, { batchId: 'b2' }] } };
      if (controller === 'GetTransactionListController') return { messages: { resultCode: 'Ok' }, transactions: { transaction: { transId: `t-${json.getTransactionListRequest.batchId}` } } };
      if (controller === 'GetTransactionDetailsController') return { messages: { resultCode: 'Ok' }, transaction: { transId: json.getTransactionDetailsRequest.transId } };
      throw new Error(controller);
    },
  });

  assert.deepEqual((await gateway.getUnsettledTransactionList(config)).map((t) => t.transId), ['1', '2']);
  const unsettledReq = seen[0].json.getUnsettledTransactionListRequest;
  assert.equal(unsettledReq.sorting.orderBy, 'submitTimeUTC');
  assert.equal(unsettledReq.sorting.orderDescending, true);

  const now = new Date('2026-10-16T12:00:00.000Z');
  const settled = await gateway.getRecentSettledTransactions(config, { now, days: 2 });
  assert.deepEqual(settled.map((t) => t.transId), ['t-b1', 't-b2']);
  const batchReq = seen.find((s) => s.controller === 'GetSettledBatchListController').json.getSettledBatchListRequest;
  assert.equal(batchReq.firstSettlementDate, '2026-10-14T12:00:00Z');
  assert.equal(batchReq.lastSettlementDate, '2026-10-16T12:00:00Z');

  assert.equal((await gateway.getTransactionDetails(config, '6001')).transId, '6001');
});

test('a lookup answered with resultCode Error throws GatewayLookupError', async () => {
  const gateway = createGateway({ execute: async () => ({ messages: { resultCode: 'Error', message: [{ code: 'E00011', text: 'Access denied.' }] } }) });
  await assert.rejects(gateway.getUnsettledTransactionList(config), GatewayLookupError);
  await assert.rejects(gateway.getTransactionDetails(config, '1'), GatewayLookupError);
});
