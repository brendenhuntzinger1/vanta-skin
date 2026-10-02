(function () {
  const S = window.STORE;
  const P = window.PRODUCTS;
  const money = (n) => "$" + Number(n).toFixed(2);
  const byId = (id) => P.find((p) => p.id === id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- storage (fails gracefully) ---------------- */
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  /* ---------------- cart ---------------- */
  const Cart = {
    items() { return store.get("vanta_cart", []).filter((i) => byId(i.id)); },
    save(items) { store.set("vanta_cart", items); updateCount(); },
    add(id, qty = 1) {
      const items = this.items();
      const it = items.find((i) => i.id === id);
      if (it) it.qty = Math.min(99, it.qty + qty); else items.push({ id, qty });
      this.save(items);
    },
    setQty(id, qty) {
      let items = this.items();
      if (qty <= 0) items = items.filter((i) => i.id !== id);
      else items.forEach((i) => { if (i.id === id) i.qty = Math.min(99, qty); });
      this.save(items);
    },
    count() { return this.items().reduce((a, i) => a + i.qty, 0); },
    subtotal() { return this.items().reduce((a, i) => a + byId(i.id).price * i.qty, 0); },
    clear() { this.save([]); },
  };
  window.VantaCart = Cart;

  function updateCount() {
    document.querySelectorAll(".cart-count").forEach((el) => (el.textContent = Cart.count()));
  }

  function toast(msg) {
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.innerHTML = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 3200);
  }

  /* ---------------- layout ---------------- */
  const page = document.body.dataset.page || "";
  const logo = `<a class="logo" href="index.html" aria-label="${S.brand} home"><b>VANTA</b><small>SKIN</small></a>`;

  function header() {
    const link = (href, label, key) => `<a href="${href}" class="${page === key ? "active" : ""}">${label}</a>`;
    return `
      <div class="announce">Free U.S. shipping on orders over ${money(S.freeShippingThreshold).replace(".00", "")} &nbsp;•&nbsp; 30-day satisfaction guarantee</div>
      <header class="header"><div class="container">
        <button class="menu-toggle" aria-label="Open menu" aria-expanded="false">☰</button>
        ${logo}
        <nav class="nav" aria-label="Main">
          ${link("shop.html", "Shop All", "shop")}
          ${link("product.html?id=ghk-cu-whipped-tallow-balm", "GHK-Cu Balm", "balm")}
          ${link("about.html", "Our Story", "about")}
          ${link("faq.html", "FAQ", "faq")}
          ${link("contact.html", "Contact", "contact")}
        </nav>
        <div class="header-actions"><a class="cart-btn" href="cart.html" aria-label="Cart">Cart <span class="cart-count">0</span></a></div>
      </div></header>`;
  }

  function footer() {
    return `
      <footer class="footer"><div class="container">
        <div class="footer-grid">
          <div>${logo}<p>Simple, effective skincare built around our signature GHK-Cu Whipped Tallow Balm. Small-batch. Thoughtfully made.</p>
            <p><a href="mailto:${S.email}">${S.email}</a>${S.phone ? `<br>${S.phone}` : ""}</p></div>
          <div><h4>Shop</h4><ul>
            <li><a href="shop.html">Shop All</a></li>
            <li><a href="product.html?id=ghk-cu-whipped-tallow-balm">GHK-Cu Tallow Balm</a></li>
            <li><a href="product.html?id=vanta-ritual-set">The Ritual Set</a></li>
            <li><a href="cart.html">Cart</a></li></ul></div>
          <div><h4>Help</h4><ul>
            <li><a href="faq.html">FAQ</a></li>
            <li><a href="shipping.html">Shipping Policy</a></li>
            <li><a href="returns.html">Returns &amp; Refunds</a></li>
            <li><a href="track.html">Track Your Order</a></li>
            <li><a href="contact.html">Contact Us</a></li></ul></div>
          <div><h4>Legal</h4><ul>
            <li><a href="privacy.html">Privacy Policy</a></li>
            <li><a href="terms.html">Terms of Service</a></li>
            <li><a href="disclaimer.html">Product Disclaimer</a></li>
            <li><a href="accessibility.html">Accessibility</a></li></ul></div>
        </div>
        <p class="fda">These statements have not been evaluated by the Food and Drug Administration. Vanta Skin products are cosmetics and are not intended to diagnose, treat, cure, or prevent any disease. Always patch test before use and consult a physician if you are pregnant, nursing, or have a skin condition.</p>
        <div class="footer-bottom"><span>© ${new Date().getFullYear()} ${S.legalName}. All rights reserved.</span><span>${S.address}</span></div>
      </div></footer>`;
  }

  function fillConfig() {
    document.querySelectorAll("[data-s]").forEach((el) => {
      const k = el.dataset.s;
      if (k === "email") el.innerHTML = `<a href="mailto:${S.email}">${S.email}</a>`;
      else if (k === "threshold") el.textContent = money(S.freeShippingThreshold);
      else if (S[k] !== undefined) el.textContent = S[k];
    });
  }

  function cookieBar() {
    if (store.get("vanta_cookie_ok", false)) return;
    const bar = document.createElement("div");
    bar.className = "cookie";
    bar.innerHTML = `<span>We use essential cookies and local storage to run our cart. See our <a href="privacy.html">Privacy Policy</a>.</span><button class="btn">OK</button>`;
    bar.querySelector("button").onclick = () => { store.set("vanta_cookie_ok", true); bar.remove(); };
    document.body.appendChild(bar);
  }

  /* ---------------- components ---------------- */
  function card(p) {
    return `<article class="card">
      <a class="card-img" href="product.html?id=${p.id}">${productArt(p)}</a>
      <div class="card-body">
        ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}
        <h3><a href="product.html?id=${p.id}">${esc(p.name)}</a></h3>
        <div class="sub">${esc(p.sub)} · ${esc(p.size)}</div>
        <div class="card-foot"><span class="price">${money(p.price)}${p.compareAt ? ` <s class="muted" style="font-weight:400">${money(p.compareAt)}</s>` : ""}</span>
        <button class="add-mini" data-add="${p.id}">Add to cart</button></div>
      </div></article>`;
  }

  function bindAdd(root = document) {
    root.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => { const p = byId(b.dataset.add); Cart.add(p.id, 1); toast(`Added ${esc(p.name)} <a href="cart.html">View cart</a>`); };
    });
  }

  /* ---------------- pages ---------------- */
  function renderGrid(sel, list) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.innerHTML = list.map(card).join("");
    bindAdd(el);
  }

  function shopPage() {
    const filters = document.getElementById("filters");
    if (!filters) return;
    const cats = ["All", ...new Set(P.map((p) => p.category))];
    let cur = new URLSearchParams(location.search).get("c") || "All";
    const draw = () => {
      filters.innerHTML = cats.map((c) => `<button class="btn ${c === cur ? "" : "outline"}" style="padding:8px 18px;font-size:.85rem" data-c="${c}">${c}</button>`).join(" ");
      filters.querySelectorAll("button").forEach((b) => (b.onclick = () => { cur = b.dataset.c; draw(); }));
      renderGrid("#shop-grid", cur === "All" ? P : P.filter((p) => p.category === cur));
    };
    draw();
  }

  function productPage() {
    const root = document.getElementById("pdp");
    if (!root) return;
    const p = byId(new URLSearchParams(location.search).get("id")) || P[0];
    document.title = `${p.name} | ${S.brand}`;
    const imgs = p.images && p.images.length ? p.images : null;
    root.innerHTML = `
      <div class="breadcrumb"><a href="index.html">Home</a> / <a href="shop.html">Shop</a> / ${esc(p.name)}</div>
      <div class="pdp">
        <div>
          <div class="gallery-main" id="main-img">${productArt(p)}</div>
          ${imgs && imgs.length > 1 ? `<div class="thumbs">${imgs.map((src, i) => `<button class="${i === 0 ? "active" : ""}" data-src="${src}" aria-label="View image ${i + 1}"><img src="${src}" alt=""></button>`).join("")}</div>` : ""}
        </div>
        <div>
          ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}
          <h1>${esc(p.name)}</h1>
          <div class="muted">${esc(p.sub)} · ${esc(p.size)}</div>
          <div class="price">${money(p.price)}${p.compareAt ? ` <s class="muted" style="font-size:1rem;font-weight:400">${money(p.compareAt)}</s>` : ""}</div>
          <p>${esc(p.short)}</p>
          <div class="buy-row">
            <div class="qty"><button type="button" data-q="-1" aria-label="Decrease quantity">−</button><input id="qty" type="number" min="1" max="99" value="1" aria-label="Quantity"><button type="button" data-q="1" aria-label="Increase quantity">+</button></div>
            <button class="btn" id="add-btn">Add to Cart</button>
          </div>
          <div class="perks">
            <div>🚚 Free U.S. shipping on orders over ${money(S.freeShippingThreshold)}</div>
            <div>📦 Ships in ${S.processingTime}</div>
            <div>↩︎ 30-day satisfaction guarantee — <a href="returns.html">details</a></div>
          </div>
          <details open><summary>Description</summary>${p.description.map((d) => `<p>${esc(d)}</p>`).join("")}
            <ul>${p.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></details>
          ${p.keyIngredients ? `<details><summary>Key Ingredients</summary><ul>${p.keyIngredients.map(([n, d]) => `<li><strong>${esc(n)}</strong> — ${esc(d)}</li>`).join("")}</ul></details>` : ""}
          <details><summary>How to Use</summary><p>${esc(p.howTo)}</p></details>
          <details><summary>Ingredients</summary><p>${esc(p.ingredients)}</p></details>
          <details><summary>Caution</summary><p>${esc(p.caution)}</p></details>
          <details><summary>Shipping &amp; Returns</summary><p>Orders ship from the U.S. within ${S.processingTime}. Standard shipping takes 5–8 business days. See our <a href="shipping.html">Shipping Policy</a> and <a href="returns.html">Returns Policy</a>.</p></details>
        </div>
      </div>`;
    const qty = root.querySelector("#qty");
    root.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { qty.value = Math.max(1, Math.min(99, (+qty.value || 1) + +b.dataset.q)); }));
    root.querySelector("#add-btn").onclick = () => { Cart.add(p.id, Math.max(1, Math.min(99, +qty.value || 1))); toast(`Added ${esc(p.name)} <a href="cart.html">View cart</a>`); };
    root.querySelectorAll(".thumbs button").forEach((b) => (b.onclick = () => {
      root.querySelector("#main-img").innerHTML = `<img src="${b.dataset.src}" alt="${esc(p.name)}">`;
      root.querySelectorAll(".thumbs button").forEach((x) => x.classList.toggle("active", x === b));
    }));
    renderGrid("#related", P.filter((x) => x.id !== p.id).slice(0, 4));
  }

  function shipMeter(sub) {
    const left = S.freeShippingThreshold - sub;
    const pct = Math.min(100, (sub / S.freeShippingThreshold) * 100);
    return `<div class="ship-meter">${left > 0 ? `You're <strong>${money(left)}</strong> away from free shipping.` : `🎉 You've unlocked <strong>free shipping!</strong>`}<div class="meter"><div style="width:${pct}%"></div></div></div>`;
  }

  function cartPage() {
    const root = document.getElementById("cart");
    if (!root) return;
    const draw = () => {
      const items = Cart.items();
      if (!items.length) {
        root.innerHTML = `<div class="empty"><h2>Your cart is empty</h2><p class="muted">Looks like you haven't added anything yet.</p><a class="btn" href="shop.html">Shop Now</a></div>`;
        return;
      }
      const sub = Cart.subtotal();
      root.innerHTML = `<div class="cart-layout">
        <table class="cart-table"><thead><tr><th>Product</th><th>Quantity</th><th style="text-align:right">Total</th></tr></thead><tbody>
        ${items.map((i) => { const p = byId(i.id); return `<tr>
          <td><div class="cart-item"><a class="cart-thumb" href="product.html?id=${p.id}">${productArt(p)}</a><div><a href="product.html?id=${p.id}" style="color:var(--ink);font-weight:600">${esc(p.name)}</a><div class="muted" style="font-size:.85rem">${esc(p.size)} · ${money(p.price)}</div><button class="remove" data-rm="${p.id}">Remove</button></div></div></td>
          <td><div class="qty"><button data-id="${p.id}" data-d="-1" aria-label="Decrease">−</button><input value="${i.qty}" data-in="${p.id}" type="number" min="1" max="99" aria-label="Quantity"><button data-id="${p.id}" data-d="1" aria-label="Increase">+</button></div></td>
          <td style="text-align:right;font-weight:600">${money(p.price * i.qty)}</td></tr>`; }).join("")}
        </tbody></table>
        <aside class="summary">
          ${shipMeter(sub)}
          <div class="row"><span>Subtotal</span><span>${money(sub)}</span></div>
          <div class="row muted"><span>Shipping</span><span>Calculated at checkout</span></div>
          <div class="row muted"><span>Sales tax</span><span>Calculated at checkout</span></div>
          <div class="row total"><span>Estimated total</span><span>${money(sub)}</span></div>
          <a class="btn block" href="checkout.html" style="margin-top:16px">Checkout</a>
          <a href="shop.html" class="center" style="display:block;margin-top:12px;font-size:.9rem">Continue shopping</a>
        </aside></div>`;
      root.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { Cart.setQty(b.dataset.rm, 0); draw(); }));
      root.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { const it = Cart.items().find((x) => x.id === b.dataset.id); Cart.setQty(b.dataset.id, it.qty + +b.dataset.d); draw(); }));
      root.querySelectorAll("[data-in]").forEach((inp) => (inp.onchange = () => { Cart.setQty(inp.dataset.in, Math.max(0, Math.min(99, parseInt(inp.value) || 0))); draw(); }));
    };
    draw();
  }

  function checkoutPage() {
    const form = document.getElementById("checkout-form");
    if (!form) return;
    const items = Cart.items();
    if (!items.length) { location.href = "cart.html"; return; }
    const shipBox = document.getElementById("ship-options");
    const sub = Cart.subtotal();
    const free = sub >= S.freeShippingThreshold;
    shipBox.innerHTML = S.shipping.map((s, i) => {
      const price = s.id === "standard" && free ? 0 : s.price;
      return `<label class="ship-opt"><span><input type="radio" name="shipping" value="${s.id}" data-price="${price}" ${i === 0 ? "checked" : ""}>${s.name} <span class="muted">(${s.eta})</span></span><strong>${price ? money(price) : "FREE"}</strong></label>`;
    }).join("");
    const summary = document.getElementById("order-summary");
    const draw = () => {
      const ship = +form.querySelector("[name=shipping]:checked").dataset.price;
      summary.innerHTML = `${items.map((i) => { const p = byId(i.id); return `<div class="row"><span>${esc(p.name)} × ${i.qty}</span><span>${money(p.price * i.qty)}</span></div>`; }).join("")}
        <div class="row" style="border-top:1px solid var(--line);margin-top:8px;padding-top:12px"><span>Subtotal</span><span>${money(sub)}</span></div>
        <div class="row"><span>Shipping</span><span>${ship ? money(ship) : "FREE"}</span></div>
        <div class="row muted"><span>Sales tax</span><span>Calculated by payment provider</span></div>
        <div class="row total"><span>Total</span><span>${money(sub + ship)} <small class="muted" style="font-weight:400">+ tax</small></span></div>`;
    };
    form.addEventListener("change", draw);
    draw();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = document.getElementById("checkout-msg");
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const data = Object.fromEntries(new FormData(form).entries());
      const order = { items, subtotal: sub, shipping: data.shipping, customer: data };
      if (S.paymentsEnabled && typeof window.VANTA_PAY === "function") { window.VANTA_PAY(order); return; }
      msg.innerHTML = `<div class="notice"><strong>Checkout is almost ready.</strong> Online payments are being set up — please check back shortly or email <a href="mailto:${S.email}">${S.email}</a> to place your order. Your cart has been saved.</div>`;
    });
  }

  function forms() {
    document.querySelectorAll("form[data-simple]").forEach((f) => {
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!f.checkValidity()) { f.reportValidity(); return; }
        const m = f.querySelector(".form-msg");
        // NOTE: connect to your email/CRM provider (e.g. Formspree, Klaviyo) by setting the form's action.
        if (f.getAttribute("action")) { f.submit(); return; }
        m.textContent = f.dataset.simple;
        f.reset();
      });
    });
  }

  /* ---------------- init ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    const h = document.getElementById("site-header"); if (h) h.outerHTML = header();
    const f = document.getElementById("site-footer"); if (f) f.outerHTML = footer();
    const t = document.querySelector(".menu-toggle");
    if (t) t.onclick = () => { const n = document.querySelector(".nav"); n.classList.toggle("open"); t.setAttribute("aria-expanded", n.classList.contains("open")); };
    fillConfig();
    updateCount();
    renderGrid("#featured-grid", P.filter((p) => !p.featured).slice(0, 4));
    shopPage(); productPage(); cartPage(); checkoutPage(); forms();
    bindAdd();
    cookieBar();
  });
})();
