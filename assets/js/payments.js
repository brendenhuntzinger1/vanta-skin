(function () {
  const S = window.STORE || {};

  async function loadAuthnetConfig() {
    const res = await fetch('/api/payments/tokenize-config', { method: 'GET' });
    if (!res.ok) throw new Error('Unable to load Authorize.net tokenization config');
    const json = await res.json();
    if (!json.ok || !json.authnet?.enabled) {
      throw new Error('Authorize.net tokenization is not configured');
    }
    return json.authnet;
  }

  function loadAcceptJs(sandbox) {
    return new Promise((resolve, reject) => {
      if (window.Accept) return resolve(window.Accept);
      const script = document.createElement('script');
      script.src = sandbox
        ? 'https://jstest.authorize.net/v1/Accept.js'
        : 'https://js.authorize.net/v1/Accept.js';
      script.async = true;
      script.onload = () => resolve(window.Accept);
      script.onerror = () => reject(new Error('Unable to load Accept.js'));
      document.head.appendChild(script);
    });
  }

  function tokenizeCard(authnetConfig, card) {
    return new Promise((resolve, reject) => {
      const secureData = {
        authData: {
          apiLoginID: authnetConfig.apiLoginId,
          clientKey: authnetConfig.clientKey,
        },
        cardData: {
          cardNumber: card.number,
          month: card.month,
          year: card.year,
          cardCode: card.code,
          zip: card.zip,
        },
      };

      window.Accept.dispatchData(secureData, (response) => {
        if (response.messages.resultCode === 'Error') {
          const msg = response.messages.message?.[0]?.text || 'Card tokenization failed';
          reject(new Error(msg));
          return;
        }

        resolve(response.opaqueData);
      });
    });
  }

  function attachTokenizationForm() {
    const container = document.getElementById('payment-element');
    if (!container || !S?.paymentsEnabled) return;

    container.classList.remove('pay-placeholder');
    container.innerHTML = `
      <div class="form-grid">
        <div class="full"><label for="card-number">Card number</label><input id="card-number" inputmode="numeric" autocomplete="cc-number" required></div>
        <div><label for="card-exp-month">Exp month (MM)</label><input id="card-exp-month" inputmode="numeric" maxlength="2" autocomplete="cc-exp-month" required></div>
        <div><label for="card-exp-year">Exp year (YYYY)</label><input id="card-exp-year" inputmode="numeric" maxlength="4" autocomplete="cc-exp-year" required></div>
        <div><label for="card-code">Security code</label><input id="card-code" inputmode="numeric" autocomplete="cc-csc" required></div>
        <div><label for="card-zip">Billing ZIP</label><input id="card-zip" inputmode="numeric" autocomplete="postal-code" required></div>
      </div>
      <p class="muted" style="margin-top:8px">Card data is tokenized directly by Authorize.net via Accept.js.</p>
    `;

    window.VANTA_TOKENIZE_CARD = async function VANTA_TOKENIZE_CARD() {
      const authnetConfig = await loadAuthnetConfig();
      await loadAcceptJs(authnetConfig.sandbox);
      return tokenizeCard(authnetConfig, {
        number: document.getElementById('card-number')?.value?.trim(),
        month: document.getElementById('card-exp-month')?.value?.trim(),
        year: document.getElementById('card-exp-year')?.value?.trim(),
        code: document.getElementById('card-code')?.value?.trim(),
        zip: document.getElementById('card-zip')?.value?.trim(),
      });
    };
  }

  document.addEventListener('DOMContentLoaded', attachTokenizationForm);
})();
