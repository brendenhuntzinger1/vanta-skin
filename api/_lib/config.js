function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
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
    const parsed = JSON.parse(json);
    for (const [key, value] of Object.entries(parsed)) {
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

function loadConfig() {
  const hmacSecrets = loadHmacSecrets();
  if (!Object.keys(hmacSecrets).length) {
    throw new Error('No HMAC secrets configured. Set VANTA_HMAC_KEY_ID + VANTA_HMAC_SHARED_SECRET or VANTA_HMAC_KEYS_JSON');
  }

  return {
    authnet: {
      apiLoginId: required('AUTHNET_API_LOGIN_ID'),
      transactionKey: required('AUTHNET_TRANSACTION_KEY'),
      signatureKey: optional('AUTHNET_SIGNATURE_KEY', ''),
      sandbox: envBool('AUTHNET_SANDBOX', true),
      merchantDescriptor: optional('AUTHNET_MERCHANT_DESCRIPTOR', 'Vanta Skin'),
      defaultCurrency: optional('PAYMENTS_DEFAULT_CURRENCY', 'USD'),
    },
    hmac: {
      maxSkewSeconds: Number(optional('VANTA_HMAC_MAX_SKEW_SECONDS', '300')),
      secrets: hmacSecrets,
    },
    bridge: {
      allowedOriginStorefronts: optional('VANTA_ALLOWED_ORIGIN_STOREFRONTS', 'vantalabsresearch.com')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    },
    supabase: {
      url: required('SUPABASE_URL'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    },
    labsSync: {
      endpointUrl: optional('VANTA_LABS_SYNC_ENDPOINT_URL', ''),
      outboundKeyId: optional('VANTA_LABS_SYNC_KEY_ID', ''),
      outboundSharedSecret: optional('VANTA_LABS_SYNC_SHARED_SECRET', ''),
      timeoutMs: optionalNumber('VANTA_LABS_SYNC_TIMEOUT_MS', 8000),
      retryAuthToken: optional('VANTA_SYNC_RETRY_TOKEN', ''),
      retryBatchSize: optionalNumber('VANTA_SYNC_RETRY_BATCH_SIZE', 25),
    },
  };
}

module.exports = {
  loadConfig,
};
