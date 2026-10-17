// Runs the card frame's real inline script against a minimal fake browser:
// the fields, the parent window, location/history, fetch (session-validate),
// timers, Web Crypto and Accept.js. Tests drive it the way the Labs page, the
// network and the shopper do.
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { EMBED_SCRIPT, renderEmbedPage } = require('../../api/_lib/embed-page');

const TOKEN = `vps_${'b'.repeat(64)}`;
// First 24 hex characters of SHA-256(TOKEN), as Labs derives it.
const SESSION_ID = require('node:crypto').createHash('sha256').update(TOKEN).digest('hex').slice(0, 24);
const LABS = 'https://vantalabsresearch.com';
const OK_TOKEN = { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'opaque-token-value' };

function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Reads <meta name="…" content='…'> out of the page the server renders, so the
// frame sees exactly what a browser would.
function metaFrom(html) {
  const metas = {};
  for (const m of html.matchAll(/<meta name="([^"]+)" content='([^']*)'>/g)) metas[m[1]] = decodeAttribute(m[2]);
  return metas;
}

// accept:
//   'present'      Accept.js already on the page (the default)
//   'load'         loads when the script tag is added
//   'error'        the script tag fails (blocked, offline)
//   'hang'         the script never finishes loading
//   'no-dispatch'  loads but never defines Accept.dispatchData
// dispatch:
//   'ok' | 'error' | 'hang' | 'throw'
// validate: { status, json } or 'network'
function harness({
  url = `https://pay.vanta.skin/api/payments/embed#session=${TOKEN}`,
  accept = 'present',
  dispatch = 'ok',
  acceptResult,
  validate,
  html = renderEmbedPage([LABS, 'https://www.vantalabsresearch.com']),
  crypto = webcrypto,
} = {}) {
  const fields = {};
  const el = (id) => {
    if (!fields[id]) {
      fields[id] = { id, value: '', hidden: true, textContent: '', className: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    }
    return fields[id];
  };
  const parent = { posted: [], postMessage(message, targetOrigin) { this.posted.push({ message: structuredClone(message), targetOrigin }); } };
  const windowListeners = {};
  const location = new URL(url);
  const replaced = [];
  const fetches = [];
  const dispatched = [];
  const scripts = [];
  const pendingDispatch = [];
  const metas = metaFrom(html);

  // Fake clock: timers fire only when a test advances time.
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const setTimeoutFake = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const clearTimeoutFake = (id) => { timers.delete(id); };

  const acceptLib = {
    dispatchData(request, cb) {
      dispatched.push(structuredClone(request));
      if (dispatch === 'throw') throw new Error('library broken');
      if (dispatch === 'hang') { pendingDispatch.push(cb); return; }
      if (dispatch === 'error') {
        cb(acceptResult || { messages: { resultCode: 'Error', message: [{ code: 'E_WC_05', text: 'Please provide valid credit card number.' }] } });
        return;
      }
      cb(acceptResult || { messages: { resultCode: 'Ok', message: [] }, opaqueData: OK_TOKEN });
    },
  };

  const win = {
    parent,
    location: { search: location.search, hash: location.hash, pathname: location.pathname },
    history: { replaceState(_s, _t, next) { replaced.push(next); } },
    addEventListener(type, fn) { windowListeners[type] = fn; },
    crypto,
    Accept: accept === 'present' ? acceptLib : undefined,
  };

  const document = {
    getElementById: el,
    querySelector(selector) {
      const m = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (!m || !(m[1] in metas)) return null;
      return { getAttribute: (name) => (name === 'content' ? metas[m[1]] : null) };
    },
    createElement: (tag) => ({ tag }),
    head: {
      appendChild(script) {
        scripts.push(script);
        if (accept === 'load' || accept === 'no-dispatch') {
          setImmediate(() => {
            win.Accept = accept === 'load' ? acceptLib : {};
            if (script.onload) script.onload();
          });
        } else if (accept === 'error') {
          setImmediate(() => script.onerror && script.onerror());
        }
      },
    },
  };

  const validateReply = validate || {
    status: 200,
    json: { ok: true, sessionId: SESSION_ID, embedOrigin: LABS, authnet: { apiLoginId: 'login', clientKey: 'client', sandbox: true } },
  };

  const context = {
    window: win,
    document,
    URLSearchParams,
    TextEncoder,
    history: win.history,
    location: win.location,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    fetch: async (path, init) => {
      fetches.push({ path, body: JSON.parse(init.body) });
      if (validateReply === 'network') throw new TypeError('Failed to fetch');
      return { status: validateReply.status, json: async () => validateReply.json };
    },
    Promise,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(EMBED_SCRIPT, context);

  // Lets promise chains, Web Crypto and the fake script loads run.
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const advance = async (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = until;
    await settle();
  };

  return {
    fields, parent, fetches, replaced, dispatched, scripts, pendingDispatch, settle, advance,
    posted: (type) => parent.posted.filter((p) => p.message.type === type),
    message: (data, { origin = LABS, source = parent } = {}) => windowListeners.message && windowListeners.message({ data, origin, source }),
    fill(card) {
      for (const [id, value] of Object.entries(card)) el(id).value = value;
    },
  };
}

module.exports = { harness, metaFrom, LABS, OK_TOKEN, SESSION_ID, TOKEN };
