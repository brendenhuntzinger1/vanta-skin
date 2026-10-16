const { normalizeOrigin } = require('./payment-session');

function configError(message) {
  // The message names the missing variable for the server log only. It is
  // never put in a response body (see toErrorResponse in service.js).
  const err = new Error(message);
  err.code = 'config_error';
  return err;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw configError(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function loadHmacSecrets() {
  const map = {};
  const singleId = process.env.VANTA_HMAC_KEY_ID;
  const singleSecret = process.env.VANTA_HMAC_SHARED_SECRET;
  if (singleId && singleSecret) map[singleId] = singleSecret;

  const json = process.env.VANTA_HMAC_KEYS_JSON;
  if (json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw configError('VANTA_HMAC_KEYS_JSON is not valid JSON');
    }
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === 'string' && value) map[key] = value;
    }
  }

  return map;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function optionalNumber(name, fallback) {
  const value = optional(name, String(fallback));
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

// A finite number > 0, else the fallback. Used for windows and timeouts where
// 0, a negative or NaN would silently disable a safety check.
function positiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Live processing needs all three, exactly:
//   AUTHNET_SANDBOX === "false"        (the operator asked for live)
//   AUTHNET_LIVE_APPROVED === "true"   (written approval is on file)
//   VERCEL_ENV === "production"        (never from a preview or a laptop)
// AUTHNET_SANDBOX === "false" without the other two is a configuration error:
// the payment endpoints refuse (503, not charged) rather than guess which
// gateway was meant. Every other AUTHNET_SANDBOX value — unset, "", "TRUE",
// "on", garbage — is sandbox.
function resolveAuthnetMode(env = process.env) {
  if (env.AUTHNET_SANDBOX !== 'false') {
    return { sandbox: true, mode: 'sandbox', error: null };
  }
  if (env.AUTHNET_LIVE_APPROVED === 'true' && env.VERCEL_ENV === 'production') {
    return { sandbox: false, mode: 'live', error: null };
  }
  // Fail closed: report sandbox so nothing ever points at the production
  // gateway, and carry the error so payment endpoints refuse outright.
  return { sandbox: true, mode: 'misconfigured', error: 'live_mode_not_approved' };
}

// Callback settings, read without requiring the rest of the payment config so
// the health check can report on them before the database exists.
function loadLabsSyncConfig() {
  return {
    endpointUrl: optional('VANTA_LABS_SYNC_ENDPOINT_URL', ''),
    outboundKeyId: optional('VANTA_LABS_SYNC_KEY_ID', ''),
    outboundSharedSecret: optional('VANTA_LABS_SYNC_SHARED_SECRET', ''),
    // Short: the inline callback runs inside the charge request, after the
    // result is saved. Anything that misses it goes through the outbox.
    timeoutMs: positiveNumber('VANTA_LABS_SYNC_TIMEOUT_MS', 4000),
    retryAuthToken: optional('VANTA_SYNC_RETRY_TOKEN', ''),
    retryBatchSize: positiveNumber('VANTA_SYNC_RETRY_BATCH_SIZE', 25),
    // Vanta Labs project's "Protection Bypass for Automation" secret, needed
    // only while Labs is behind Vercel Deployment Protection (its previews).
    protectionBypass: optional('VANTA_LABS_PROTECTION_BYPASS', '').trim(),
  };
}

function hmacMaxSkewSeconds() {
  return positiveNumber('VANTA_HMAC_MAX_SKEW_SECONDS', 300);
}

// Exact https origins allowed to iframe the hosted payment component
// (Vanta Labs checkout pages). Invalid entries fail loudly at load time
// instead of silently narrowing the allowlist.
function loadAllowedEmbedOrigins() {
  return optional('VANTA_EMBED_ALLOWED_ORIGINS', 'https://vantalabsresearch.com')
    .split(',')
    .map((value) => {
      const origin = normalizeOrigin(value);
      if (!origin) throw configError(`Invalid origin in VANTA_EMBED_ALLOWED_ORIGINS: ${value.trim()}`);
      return origin;
    });
}

function loadConfig() {
  const hmacSecrets = loadHmacSecrets();
  if (!Object.keys(hmacSecrets).length) {
    throw configError('No HMAC secrets configured. Set VANTA_HMAC_KEY_ID + VANTA_HMAC_SHARED_SECRET or VANTA_HMAC_KEYS_JSON');
  }

  const mode = resolveAuthnetMode(process.env);

  return {
    authnet: {
      apiLoginId: required('AUTHNET_API_LOGIN_ID'),
      transactionKey: required('AUTHNET_TRANSACTION_KEY'),
      signatureKey: optional('AUTHNET_SIGNATURE_KEY', ''),
      sandbox: mode.sandbox,
      mode: mode.mode,
      configError: mode.error,
      merchantDescriptor: optional('AUTHNET_MERCHANT_DESCRIPTOR', 'Vanta Skin'),
      defaultCurrency: 'USD',
      timeoutMs: positiveNumber('AUTHNET_TIMEOUT_MS', 20000),
    },
    hmac: {
      maxSkewSeconds: hmacMaxSkewSeconds(),
      secrets: hmacSecrets,
    },
    bridge: {
      allowedOriginStorefronts: optional('VANTA_ALLOWED_ORIGIN_STOREFRONTS', 'vantalabsresearch.com')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
      allowedEmbedOrigins: loadAllowedEmbedOrigins(),
      paymentSessionTtlSeconds: positiveNumber('VANTA_PAYMENT_SESSION_TTL_SECONDS', 900),
      requirePaymentSession: envBool('VANTA_REQUIRE_PAYMENT_SESSION', false),
    },
    supabase: {
      url: required('SUPABASE_URL'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    },
    labsSync: loadLabsSyncConfig(),
  };
}

module.exports = {
  envBool,
  hmacMaxSkewSeconds,
  loadConfig,
  loadHmacSecrets,
  loadLabsSyncConfig,
  optionalNumber,
  positiveNumber,
  resolveAuthnetMode,
};
