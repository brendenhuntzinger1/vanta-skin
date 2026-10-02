/*
 * ---------------------------------------------------------------
 *  STORE SETTINGS — edit these values once and they update every
 *  page (header, footer, policies, checkout, contact page, etc.)
 * ---------------------------------------------------------------
 */
window.STORE = {
  brand: "Vanta Skin",
  legalName: "Vanta Skin LLC",            // your registered legal business name
  email: "support@vantaskin.com",         // customer-service email
  phone: "",                              // optional, leave "" to hide
  address: "123 Example St, Suite 100, City, ST 00000, USA", // business / returns address
  returnsAddress: "Vanta Skin Returns, 123 Example St, Suite 100, City, ST 00000, USA",
  governingState: "your state",           // e.g. "Texas" — used in Terms of Service
  domain: "vantaskin.com",
  policiesUpdated: "October 2, 2026",

  currency: "USD",
  freeShippingThreshold: 50,
  shipping: [
    { id: "standard",  name: "Standard Shipping",  eta: "5–8 business days", price: 5.95 },
    { id: "expedited", name: "Expedited Shipping", eta: "2–3 business days", price: 12.95 },
  ],
  processingTime: "1–2 business days",

  /*
   * PAYMENT PROCESSOR
   * When you connect Stripe / Shopify / Square / PayPal, replace the
   * placeholder in checkout.html (look for "PAYMENT PROCESSOR GOES HERE")
   * and implement window.VANTA_PAY(order) to send the order to your processor.
   */
  paymentsEnabled: false,
};
