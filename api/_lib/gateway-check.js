const { randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const { resolveAuthnetMode } = require('./config');

// Sandbox credential check, run from GET /api/payments/health?gateway=1.
//
// Proves the configured Authorize.Net SANDBOX credentials work without moving
// money: no charge, authorization, refund or void is ever requested. Each
// check answers pass/fail and the gateway's own result code; no credential,
// token, URL or merchant detail is returned or logged.
//
//   authenticate         authenticateTestRequest: API Login ID + Transaction Key
//   clientKeyTokenize    securePaymentContainerRequest with the Public Client Key
//                        and a sandbox test card, the same request Accept.js
//                        makes in the shopper's browser. Authorize.Net accepts
//                        it only when the client key belongs to the API Login
//                        ID's account, so this is the independent proof. The
//                        one-time token it returns is discarded unused (it
//                        expires by itself after 15 minutes).
//   merchantDetails      getMerchantDetailsRequest: test mode, and whether the
//                        account's public client key equals ours (a second,
//                        weaker signal; compared in constant time)
//   transactionDetails   getUnsettledTransactionListRequest (one row): the
//                        Transaction Details API that reconciliation needs
//   webhooks             the REST webhook list: one active endpoint pointing at
//                        this deployment with the event types Skin handles
//   webhookPing          with ping=1 only: Authorize.Net sends a signed test
//                        notification to that endpoint
//   webhookRegistration  with register=1 only: adds that endpoint when it is
//                        missing (see registerWebhook)
//
// Live credentials are never checked here: the check refuses unless the
// service is in sandbox mode, and it only ever calls the sandbox hosts.

const SANDBOX_API = 'https://apitest.authorize.net/xml/v1/request.api';
const SANDBOX_REST = 'https://apitest.authorize.net/rest/v1';
const TIMEOUT_MS = 10000;
const REQUIRED_EVENT_TYPES = [
  'net.authorize.payment.authcapture.created',
  'net.authorize.payment.refund.created',
  'net.authorize.payment.void.created',
];
// Authorize.Net's published sandbox test card.
const TEST_CARD = { cardNumber: '4111111111111111', expirationDate: '122030', cardCode: '999' };

function sameSecret(a, b) {
  const x = createHash('sha256').update(String(a || '')).digest();
  const y = createHash('sha256').update(String(b || '')).digest();
  return Boolean(a) && Boolean(b) && timingSafeEqual(x, y);
}

async function withTimeout(fetchImpl, url, init) {
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  return fetchImpl(url, { ...init, signal });
}

async function callApi(fetchImpl, request) {
  try {
    const res = await withTimeout(fetchImpl, SANDBOX_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const text = (await res.text()).replace(/^﻿/, '');
    const body = JSON.parse(text);
    const code = String(body?.messages?.message?.[0]?.code || 'unknown');
    return { ok: body?.messages?.resultCode === 'Ok', code, body };
  } catch {
    return { ok: false, code: 'unreachable', body: null };
  }
}

function basicAuth(creds) {
  return `Basic ${Buffer.from(`${creds.apiLoginId}:${creds.transactionKey}`).toString('base64')}`;
}

function describeWebhook(hook, host) {
  let pointsHere = false;
  let carriesBypass = false;
  try {
    const url = new URL(String(hook?.url || ''));
    pointsHere = url.protocol === 'https:' && Boolean(host) && url.host === host && url.pathname === '/api/payments/webhook';
    carriesBypass = url.searchParams.has('x-vercel-protection-bypass');
  } catch { /* an unparseable url points nowhere */ }
  const eventTypes = Array.isArray(hook?.eventTypes) ? hook.eventTypes.map(String) : [];
  return {
    status: String(hook?.status || 'unknown'),
    pointsHere,
    carriesBypass,
    eventTypes,
    missingEventTypes: REQUIRED_EVENT_TYPES.filter((t) => !eventTypes.includes(t)),
  };
}

async function checkWebhooks(fetchImpl, creds, host, ping) {
  let hooks;
  try {
    const res = await withTimeout(fetchImpl, `${SANDBOX_REST}/webhooks`, { method: 'GET', headers: { authorization: basicAuth(creds), accept: 'application/json' } });
    if (!res.ok) return { webhooks: { ok: false, status: res.status }, webhookPing: ping ? { ok: false, status: null, reason: 'list_failed' } : undefined };
    hooks = JSON.parse((await res.text()).replace(/^﻿/, '') || '[]');
  } catch {
    return { webhooks: { ok: false, status: null }, webhookPing: ping ? { ok: false, status: null, reason: 'list_failed' } : undefined };
  }
  if (!Array.isArray(hooks)) hooks = [];
  const described = hooks.map((h) => describeWebhook(h, host));
  const matches = hooks.filter((_, i) => described[i].pointsHere);
  const good = described.some((d) => d.pointsHere && d.status === 'active' && d.missingEventTypes.length === 0);
  const webhooks = { ok: good, count: hooks.length, matching: matches.length, endpoints: described };

  if (!ping) return { webhooks };
  const target = matches.find((h) => String(h.status) === 'active');
  if (!target) return { webhooks, webhookPing: { ok: false, status: null, reason: 'no_matching_webhook' } };
  try {
    const res = await withTimeout(fetchImpl, `${SANDBOX_REST}/webhooks/${encodeURIComponent(String(target.webhookId))}/pings`, {
      method: 'POST',
      headers: { authorization: basicAuth(creds), 'content-type': 'application/json' },
      body: '{}',
    });
    return { webhooks, webhookPing: { ok: res.status >= 200 && res.status < 300, status: res.status } };
  } catch {
    return { webhooks, webhookPing: { ok: false, status: null, reason: 'unreachable' } };
  }
}

// register=1: adds the sandbox webhook for THIS deployment when none points
// here yet. The URL comes from AUTHNET_WEBHOOK_URL (it carries the Preview's
// webhook-only Vercel bypass, so it is configuration, never a request field)
// and must be https, on this deployment's host, at /api/payments/webhook.
async function registerWebhook(fetchImpl, creds, host, rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || !host || url.host !== host || url.pathname !== '/api/payments/webhook') {
    return { ok: false, status: null, created: false, reason: 'webhook_url_invalid' };
  }
  const headers = { authorization: basicAuth(creds), 'content-type': 'application/json', accept: 'application/json' };
  try {
    const list = await withTimeout(fetchImpl, `${SANDBOX_REST}/webhooks`, { method: 'GET', headers });
    const hooks = list.ok ? JSON.parse((await list.text()).replace(/^\uFEFF/, '') || '[]') : null;
    if (!Array.isArray(hooks)) return { ok: false, status: list.status, created: false, reason: 'list_failed' };
    if (hooks.some((h) => describeWebhook(h, host).pointsHere)) return { ok: true, status: null, created: false };
    const res = await withTimeout(fetchImpl, `${SANDBOX_REST}/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'vanta-skin-sandbox-preview',
        url: url.toString(),
        eventTypes: [...REQUIRED_EVENT_TYPES, 'net.authorize.payment.capture.created'],
        status: 'active',
      }),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, created: true };
    // Authorize.Net's own reason, with any URL removed: the registered URL
    // carries the Preview's webhook bypass and must never be echoed back.
    let reason = 'rejected';
    try {
      const body = JSON.parse((await res.text()).replace(/^\uFEFF/, ''));
      reason = String(body?.message || body?.reason || reason);
    } catch { /* not JSON */ }
    reason = reason.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 200);
    return { ok: false, status: res.status, created: false, reason };
  } catch {
    return { ok: false, status: null, created: false, reason: 'unreachable' };
  }
}

async function runGatewayCheck({ env = process.env, fetchImpl = globalThis.fetch, ping = false, register = false } = {}) {
  if (resolveAuthnetMode(env).mode !== 'sandbox') return { ok: false, error: 'sandbox_only' };
  const creds = {
    apiLoginId: env.AUTHNET_API_LOGIN_ID,
    transactionKey: env.AUTHNET_TRANSACTION_KEY,
    clientKey: env.AUTHNET_CLIENT_KEY,
  };
  const missing = [['AUTHNET_API_LOGIN_ID', creds.apiLoginId], ['AUTHNET_TRANSACTION_KEY', creds.transactionKey], ['AUTHNET_CLIENT_KEY', creds.clientKey]]
    .filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => k);
  if (missing.length) return { ok: false, error: 'credentials_missing', missing };

  // The shape of each value, never the value: a pasted space or newline is the
  // commonest reason good credentials fail. Authorize.Net issues 16-character
  // transaction keys and API login ids of up to 25 characters.
  const shape = (v) => ({ surroundingWhitespace: String(v) !== String(v).trim() });
  const credentialShape = {
    apiLoginId: { ...shape(creds.apiLoginId), lengthPlausible: String(creds.apiLoginId).trim().length >= 6 && String(creds.apiLoginId).trim().length <= 25 },
    transactionKey: { ...shape(creds.transactionKey), standardLength: String(creds.transactionKey).trim().length === 16 },
    clientKey: { ...shape(creds.clientKey), lengthPlausible: String(creds.clientKey).trim().length >= 32 },
  };

  const merchantAuthentication = { name: creds.apiLoginId, transactionKey: creds.transactionKey };
  const [authenticate, tokenize, details, unsettled] = await Promise.all([
    callApi(fetchImpl, { authenticateTestRequest: { merchantAuthentication } }),
    callApi(fetchImpl, {
      securePaymentContainerRequest: {
        merchantAuthentication: { name: creds.apiLoginId, clientKey: creds.clientKey },
        data: { type: 'TOKEN', id: randomUUID(), token: TEST_CARD },
      },
    }),
    callApi(fetchImpl, { getMerchantDetailsRequest: { merchantAuthentication } }),
    callApi(fetchImpl, { getUnsettledTransactionListRequest: { merchantAuthentication, paging: { limit: 1, offset: 1 } } }),
  ]);
  // When a value carries whitespace and authentication failed, say whether the
  // trimmed values would authenticate, so the fix is known before anyone edits.
  let authenticateTrimmed;
  if (!authenticate.ok && (credentialShape.apiLoginId.surroundingWhitespace || credentialShape.transactionKey.surroundingWhitespace)) {
    const trimmed = await callApi(fetchImpl, { authenticateTestRequest: { merchantAuthentication: { name: String(creds.apiLoginId).trim(), transactionKey: String(creds.transactionKey).trim() } } });
    authenticateTrimmed = { ok: trimmed.ok, code: trimmed.code };
  }
  const host = String(env.VERCEL_BRANCH_URL || env.VERCEL_URL || '');
  const webhookRegistration = register ? await registerWebhook(fetchImpl, creds, host, env.AUTHNET_WEBHOOK_URL) : undefined;
  const hooks = await checkWebhooks(fetchImpl, creds, host, ping);

  const checks = {
    authenticate: { ok: authenticate.ok, code: authenticate.code },
    // The token in tokenize.body is never read.
    clientKeyTokenize: { ok: tokenize.ok, code: tokenize.code },
    merchantDetails: details.ok
      ? { ok: true, code: details.code, isTestMode: details.body?.isTestMode === true, publicClientKeyMatches: sameSecret(details.body?.publicClientKey, creds.clientKey) }
      : { ok: false, code: details.code },
    transactionDetails: { ok: unsettled.ok, code: unsettled.code },
    webhooks: hooks.webhooks,
    ...(register ? { webhookRegistration } : {}),
    ...(ping ? { webhookPing: hooks.webhookPing } : {}),
  };
  const ok = Object.values(checks).every((c) => c.ok) && checks.merchantDetails.publicClientKeyMatches === true;
  return { ok, checks, credentialShape, ...(authenticateTrimmed ? { authenticateTrimmed } : {}) };
}

// One gateway check per window per instance. The health endpoint also needs a
// valid bridge signature, so only a holder of the bridge secret can spend it.
function gatewayCheckLimiter({ windowMs = 60000 } = {}) {
  let last = -Infinity;
  return {
    take(now = Date.now()) {
      if (now - last < windowMs) return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (now - last)) / 1000) };
      last = now;
      return { allowed: true };
    },
  };
}

module.exports = { runGatewayCheck, gatewayCheckLimiter, SANDBOX_API, SANDBOX_REST, REQUIRED_EVENT_TYPES };
