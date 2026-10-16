const { APIContracts, APIControllers, Constants } = require('authorizenet');

function moneyFromCents(value) {
  return (Number(value) / 100).toFixed(2);
}

function normalizeRefundCardReference(value) {
  const raw = String(value || '').trim().replace(/\s+/g, '');
  if (/^\d{4}$/.test(raw)) return `XXXX${raw}`;
  if (/^X{4}\d{4}$/i.test(raw)) return raw.toUpperCase();
  throw new Error('cardNumberMasked must be last 4 digits or XXXX#### format');
}

function merchantAuth(config) {
  const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
  merchantAuthenticationType.setName(config.authnet.apiLoginId);
  merchantAuthenticationType.setTransactionKey(config.authnet.transactionKey);
  return merchantAuthenticationType;
}

function execute(controller, sandbox) {
  return new Promise((resolve, reject) => {
    controller.setEnvironment(sandbox ? Constants.endpoint.sandbox : Constants.endpoint.production);
    controller.execute(() => {
      const apiResponse = controller.getResponse();
      if (!apiResponse) {
        reject(new Error('Authorize.net returned an empty response'));
        return;
      }
      resolve(JSON.parse(apiResponse));
    });
  });
}

function mapMessage(response) {
  const direct = response?.messages?.message?.[0];
  const tx = response?.transactionResponse;
  const txErr = tx?.errors?.[0];
  const txMsg = tx?.messages?.[0];
  return txErr?.errorText || txMsg?.description || direct?.text || 'Payment processor error';
}

function mapCode(response) {
  return response?.transactionResponse?.responseCode || response?.messages?.resultCode || null;
}

// Authorize.Net is sent only what the charge needs (owner, 2026-10-16): the
// amount, the Accept.js token, the order id as invoice number and a
// description naming the originating storefront. No product lines and no
// customer email, even when the storefront supplies them.
function buildChargeRequest(config, payload) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(payload.capture === false ? APIContracts.TransactionTypeEnum.AUTHONLYTRANSACTION : APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);
  transactionRequestType.setAmount(moneyFromCents(payload.amountCents));

  const opaqueData = new APIContracts.OpaqueDataType();
  opaqueData.setDataDescriptor(payload.opaqueData.dataDescriptor);
  opaqueData.setDataValue(payload.opaqueData.dataValue);

  const paymentType = new APIContracts.PaymentType();
  paymentType.setOpaqueData(opaqueData);
  transactionRequestType.setPayment(paymentType);

  if (payload.orderId || payload.originStorefront) {
    const order = new APIContracts.OrderType();
    order.setInvoiceNumber(String(payload.orderId || '').slice(0, 20));
    order.setDescription(`${config.authnet.merchantDescriptor} | ${payload.originStorefront || 'unknown storefront'}`.slice(0, 255));
    transactionRequestType.setOrder(order);
  }

  const request = new APIContracts.CreateTransactionRequest();
  request.setMerchantAuthentication(merchantAuth(config));
  request.setTransactionRequest(transactionRequestType);
  return request;
}

async function chargeOpaqueData(config, payload) {
  const request = buildChargeRequest(config, payload);
  const controller = new APIControllers.CreateTransactionController(request.getJSON());
  const response = await execute(controller, config.authnet.sandbox);

  const tx = response?.transactionResponse;
  const approved = tx?.responseCode === '1' && tx?.transId;

  return {
    ok: !!approved,
    transactionId: tx?.transId || null,
    authorizationCode: tx?.authCode || null,
    statusCode: mapCode(response),
    message: mapMessage(response),
    raw: response,
  };
}

async function voidTransaction(config, transactionId) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.VOIDTRANSACTION);
  transactionRequestType.setRefTransId(String(transactionId));

  const request = new APIContracts.CreateTransactionRequest();
  request.setMerchantAuthentication(merchantAuth(config));
  request.setTransactionRequest(transactionRequestType);

  const controller = new APIControllers.CreateTransactionController(request.getJSON());
  const response = await execute(controller, config.authnet.sandbox);
  const tx = response?.transactionResponse;

  return {
    ok: tx?.responseCode === '1' && !!tx?.transId,
    transactionId: tx?.transId || null,
    statusCode: mapCode(response),
    message: mapMessage(response),
    raw: response,
  };
}

async function refundTransaction(config, payload) {
  const transactionRequestType = new APIContracts.TransactionRequestType();
  transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.REFUNDTRANSACTION);
  transactionRequestType.setAmount(moneyFromCents(payload.amountCents));
  transactionRequestType.setRefTransId(String(payload.transactionId));

  const card = new APIContracts.CreditCardType();
  card.setCardNumber(normalizeRefundCardReference(payload.cardNumberMasked));
  card.setExpirationDate(String(payload.expirationDate || 'XXXX'));

  const payment = new APIContracts.PaymentType();
  payment.setCreditCard(card);
  transactionRequestType.setPayment(payment);

  const request = new APIContracts.CreateTransactionRequest();
  request.setMerchantAuthentication(merchantAuth(config));
  request.setTransactionRequest(transactionRequestType);

  const controller = new APIControllers.CreateTransactionController(request.getJSON());
  const response = await execute(controller, config.authnet.sandbox);
  const tx = response?.transactionResponse;

  return {
    ok: tx?.responseCode === '1' && !!tx?.transId,
    transactionId: tx?.transId || null,
    statusCode: mapCode(response),
    message: mapMessage(response),
    raw: response,
  };
}

module.exports = {
  buildChargeRequest,
  chargeOpaqueData,
  normalizeRefundCardReference,
  refundTransaction,
  voidTransaction,
};
