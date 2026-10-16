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
    supabase: {
      url: required('SUPABASE_URL'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
      ordersTable: optional('SUPABASE_ORDERS_TABLE', 'orders'),
      orderIdColumn: optional('SUPABASE_ORDER_ID_COLUMN', 'id'),
      orderAmountColumn: optional('SUPABASE_ORDER_AMOUNT_COLUMN', 'total_amount_cents'),
      orderCurrencyColumn: optional('SUPABASE_ORDER_CURRENCY_COLUMN', 'currency'),
      orderStatusColumn: optional('SUPABASE_ORDER_PAYMENT_STATUS_COLUMN', 'payment_status'),
      orderTransactionColumn: optional('SUPABASE_ORDER_PAYMENT_TRANSACTION_COLUMN', 'payment_transaction_id'),
      orderUpdatedAtColumn: optional('SUPABASE_ORDER_UPDATED_AT_COLUMN', 'updated_at'),
    },
  };
}

module.exports = {
  loadConfig,
};
