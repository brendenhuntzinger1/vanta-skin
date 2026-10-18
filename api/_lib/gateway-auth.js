// Read-only proof that Authorize.Net accepts this service's API login, against
// the gateway the current mode points at (live in Production, sandbox
// elsewhere). One authenticateTestRequest: no transaction, no money, nothing
// written. The answer is a state, never a credential.
//
// "Credentials present" is not enough: on 2026-10-17 the live keys were set
// and correct, and every call was refused with E00008 (the Payment Gateway
// Account was not enabled). Labs must not be told the processor is ready
// while the gateway refuses it.

const LIVE_API = 'https://api.authorize.net/xml/v1/request.api';
const SANDBOX_API = 'https://apitest.authorize.net/xml/v1/request.api';
const CACHE_MS = 60_000;

function createGatewayAuthCheck({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null; // { key, at, result }

  return async function checkGatewayAuth({ env = process.env, sandbox }) {
    const name = String(env.AUTHNET_API_LOGIN_ID || '').trim();
    const transactionKey = String(env.AUTHNET_TRANSACTION_KEY || '').trim();
    if (!name || !transactionKey) return 'missing';

    const key = sandbox ? 'sandbox' : 'live';
    if (cached && cached.key === key && now() - cached.at < CACHE_MS) return cached.result;

    let result;
    try {
      const res = await fetchImpl(sandbox ? SANDBOX_API : LIVE_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authenticateTestRequest: { merchantAuthentication: { name, transactionKey } } }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = JSON.parse(String(await res.text()).replace(/^﻿/, ''));
      const message = body?.messages?.message?.[0] || {};
      const code = /^[A-Z]\d{5}$/.test(String(message.code || '')) ? String(message.code) : 'unknown';
      result = body?.messages?.resultCode === 'Ok' ? 'verified' : `rejected:${code}`;
    } catch {
      result = 'unreachable';
    }
    cached = { key, at: now(), result };
    return result;
  };
}

module.exports = { createGatewayAuthCheck, LIVE_API, SANDBOX_API };
