# Vanta Skin — Storefront

Static e-commerce site (plain HTML/CSS/JS, no build step). Host anywhere: Netlify, Vercel, GitHub Pages, Cloudflare Pages.

## Before launch
1. **`assets/js/config.js`** — set legal business name, support email, address, returns address, governing state. These fill every page and policy automatically.
2. **Payments** — in `checkout.html` replace the block marked `PAYMENT PROCESSOR GOES HERE` (Stripe, Square, PayPal, or Shopify Buy Button), set `paymentsEnabled: true` and define `window.VANTA_PAY(order)`.
3. **Forms** — newsletter/contact/track forms show a confirmation only. Add an `action` URL (e.g. Formspree, Klaviyo) to send them somewhere.
4. **Products** — edit `assets/js/products.js` (prices, descriptions, images in `assets/img/`).
5. Have the policies reviewed by an attorney, and fill in the real INCI ingredient list on the jar label.

## Pages
Home, Shop, Product, Cart, Checkout, Our Story, Contact, FAQ, Track Order, Shipping, Returns & Refunds, Privacy, Terms, Product Disclaimer, Accessibility, 404.
