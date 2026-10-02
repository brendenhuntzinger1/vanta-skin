/* Product catalog. Prices in USD. Add / edit products here. */
window.PRODUCTS = [
  {
    id: "ghk-cu-whipped-tallow-balm",
    name: "GHK-Cu Whipped Tallow Balm",
    sub: "Copper Tripeptide-1 • Tallow • Honey",
    size: "60 g / 2.1 oz",
    price: 48,
    category: "Moisturizers",
    badge: "Bestseller",
    featured: true,
    images: ["assets/img/balm-open.jpg", "assets/img/balm-hero.jpg"],
    short: "Our signature whipped facial balm — grass-fed beef tallow and copper tripeptide-1 in a rich, airy texture that melts into skin for deep hydration and barrier support.",
    description: [
      "The Vanta Skin GHK-Cu Whipped Tallow Balm pairs time-honored grass-fed beef tallow with modern copper tripeptide-1 (GHK-Cu) for a balm that feels as good as it looks. Whipped to a light, cloud-like texture, it spreads easily and leaves skin feeling soft, supple and comfortable — never greasy.",
      "Manuka honey, jojoba oil and vitamin E round out the formula to help condition and protect the skin's moisture barrier. The signature soft-blue hue comes from methylene blue.",
    ],
    highlights: [
      "Deeply moisturizes dry and dehydrated skin",
      "Supports a healthy-looking skin barrier",
      "Helps skin look smoother and more radiant",
      "Whipped texture absorbs without heavy residue",
      "No synthetic fragrance",
    ],
    keyIngredients: [
      ["Grass-Fed Beef Tallow", "Rich in lipids similar to those found in skin; replenishes dryness and reinforces the moisture barrier."],
      ["GHK-Cu (Copper Tripeptide-1)", "A skin-conditioning peptide that helps skin look firmer and smoother."],
      ["Manuka Honey", "A natural humectant that soothes and comforts delicate skin."],
      ["Jojoba Oil & Vitamin E", "Nourishing oil and antioxidant that help protect skin from environmental stressors."],
      ["Methylene Blue", "Provides the balm's signature blue color."],
    ],
    howTo: "Warm a small, pea-sized amount between fingertips and massage gently into clean, dry skin until absorbed. Use morning and/or evening. A little goes a long way.",
    ingredients: "Full INCI ingredient list is printed on the product packaging. Key ingredients: Beef Tallow, Copper Tripeptide-1, Honey (Manuka), Simmondsia Chinensis (Jojoba) Seed Oil, Tocopherol (Vitamin E), Methylene Blue.",
    caution: "For external use only. Avoid contact with eyes. Patch test before first use. Discontinue use if irritation occurs. Keep out of reach of children. Store in a cool, dry place away from direct sunlight.",
  },
  {
    id: "gentle-milk-cleanser",
    images: ["assets/img/cleanser.jpg"],
    name: "Gentle Milk Cleanser",
    sub: "Oat • Glycerin • Aloe",
    size: "120 ml / 4 fl oz",
    price: 24,
    category: "Cleansers",
    color: "#f3efe7",
    short: "A creamy, low-foam cleanser that lifts away makeup, sunscreen and daily grime without stripping skin.",
    description: ["A soft, milky cleanser made for the first step of your routine. Colloidal oat and aloe help keep skin calm and comfortable while glycerin helps it feel hydrated — never tight — after rinsing."],
    highlights: ["Non-stripping, low-foam formula", "Removes makeup and sunscreen", "Suitable for dry and sensitive skin types"],
    howTo: "Massage a small amount onto damp skin for 30–60 seconds. Rinse with lukewarm water and pat dry. Follow with your Vanta Skin balm.",
    ingredients: "Full INCI ingredient list printed on packaging. Key ingredients: Colloidal Oatmeal, Glycerin, Aloe Barbadensis Leaf Juice.",
    caution: "For external use only. Avoid contact with eyes; if contact occurs, rinse thoroughly with water. Discontinue use if irritation occurs. Keep out of reach of children.",
  },
  {
    id: "hydrating-facial-mist",
    images: ["assets/img/mist.jpg"],
    name: "Hydrating Facial Mist",
    sub: "Hyaluronic Acid • Rose Water",
    size: "100 ml / 3.4 fl oz",
    price: 22,
    category: "Toners & Mists",
    color: "#f6dfe4",
    short: "A fine, refreshing mist that preps skin for your balm and gives a quick hit of hydration any time of day.",
    description: ["A weightless facial mist with hyaluronic acid and rose water. Use it after cleansing to prep skin, over makeup to refresh, or any time your skin feels tight."],
    highlights: ["Ultra-fine continuous spray", "Preps skin to help balm spread evenly", "Refreshes over makeup"],
    howTo: "Hold 8–10 inches from face, close eyes and mist evenly. Use after cleansing, before balm, or throughout the day.",
    ingredients: "Full INCI ingredient list printed on packaging. Key ingredients: Rosa Damascena Flower Water, Sodium Hyaluronate, Glycerin.",
    caution: "For external use only. Avoid spraying directly into eyes. Discontinue use if irritation occurs. Keep out of reach of children.",
  },
  {
    id: "tallow-honey-lip-balm",
    images: ["assets/img/lip.jpg"],
    name: "Tallow & Honey Lip Balm",
    sub: "Tallow • Beeswax • Honey",
    size: "4.5 g / 0.15 oz",
    price: 10,
    category: "Lip Care",
    color: "#f2d7a6",
    short: "A rich, unscented lip balm that softens and protects dry, chapped lips.",
    description: ["Made with the same grass-fed tallow we use in our signature balm, plus beeswax and honey to help lock in moisture and keep lips soft and smooth."],
    highlights: ["Unscented", "Long-lasting moisture", "Pocket-size tube"],
    howTo: "Apply liberally to lips as often as needed.",
    ingredients: "Full INCI ingredient list printed on packaging. Key ingredients: Beef Tallow, Cera Alba (Beeswax), Honey.",
    caution: "Discontinue use if irritation occurs. Keep out of reach of children. Store away from heat.",
  },
  {
    id: "stainless-gua-sha",
    images: ["assets/img/guasha.jpg"],
    name: "Stainless Steel Gua Sha",
    sub: "Cooling facial massage tool",
    size: "1 tool + pouch",
    price: 26,
    category: "Tools",
    color: "#d9dee5",
    tool: true,
    short: "A naturally cooling, easy-to-clean stainless gua sha for a relaxing facial massage with your balm.",
    description: ["Our 304 stainless steel gua sha stays cool to the touch and is easy to sanitize. Use it with a thin layer of balm for a relaxing massage that leaves skin looking refreshed."],
    highlights: ["Naturally cooling stainless steel", "Won't chip or crack like stone", "Includes soft storage pouch"],
    howTo: "Apply balm to face. Holding the tool at a low angle, glide gently upward and outward along the jaw, cheeks and forehead 3–5 times per area. Clean with soap and warm water after each use.",
    ingredients: "304 stainless steel. Cotton pouch.",
    caution: "Use light pressure. Do not use on broken, irritated or sunburned skin. Not a toy — keep away from small children.",
  },
  {
    id: "vanta-ritual-set",
    images: ["assets/img/set.jpg"],
    name: "The Vanta Ritual Set",
    sub: "Cleanser + Mist + Balm + Lip",
    size: "4-piece set",
    price: 89,
    category: "Stacks",
    badge: "Save $15",
    color: "#2b6cb0",
    stack: ["gentle-milk-cleanser", "hydrating-facial-mist", "ghk-cu-whipped-tallow-balm", "tallow-honey-lip-balm"],
    tagline: "The full daily routine, gift-boxed.",
    short: "Our complete routine in one box: Gentle Milk Cleanser, Hydrating Facial Mist, full-size GHK-Cu Whipped Tallow Balm and Tallow & Honey Lip Balm.",
    description: ["Everything you need for a simple, effective daily routine — cleanse, hydrate, moisturize and protect. Packaged in a gift-ready box."],
    highlights: ["Full-size GHK-Cu Whipped Tallow Balm (60 g)", "Gentle Milk Cleanser (120 ml)", "Hydrating Facial Mist (100 ml)", "Tallow & Honey Lip Balm", "Gift-ready packaging — save $15"],
    howTo: "1. Cleanse with the Gentle Milk Cleanser. 2. Mist with the Hydrating Facial Mist. 3. Seal in moisture with the GHK-Cu Whipped Tallow Balm. 4. Finish with lip balm.",
    ingredients: "See each individual product. Full INCI lists printed on each package.",
    caution: "For external use only. See each product for individual cautions. Keep out of reach of children.",
  },
  {
    id: "barrier-stack",
    name: "The Barrier Stack",
    sub: "Cleanser + Balm",
    size: "2-piece stack",
    price: 62,
    category: "Stacks",
    stack: ["gentle-milk-cleanser", "ghk-cu-whipped-tallow-balm"],
    tagline: "The essentials: cleanse gently, then seal in moisture.",
    short: "Our two-step starter stack: the Gentle Milk Cleanser and the full-size GHK-Cu Whipped Tallow Balm. The simplest way to start the Vanta routine.",
    description: ["Start with a non-stripping cleanse, then follow with our signature balm to help support a healthy-looking moisture barrier. Two products, morning and night — nothing extra."],
    highlights: ["Full-size GHK-Cu Whipped Tallow Balm (60 g)", "Gentle Milk Cleanser (120 ml)", "Great for dry and sensitive skin types"],
    howTo: "1. Massage the Gentle Milk Cleanser onto damp skin, rinse and pat dry. 2. Warm a pea-sized amount of balm between fingertips and press into skin. Use morning and/or evening.",
    ingredients: "See each individual product. Full INCI lists printed on each package.",
    caution: "For external use only. See each product for individual cautions. Patch test before first use. Keep out of reach of children.",
  },
  {
    id: "sculpt-stack",
    name: "The Sculpt Stack",
    sub: "Balm + Gua Sha",
    size: "2-piece stack",
    price: 64,
    category: "Stacks",
    stack: ["ghk-cu-whipped-tallow-balm", "stainless-gua-sha"],
    tagline: "Balm plus a cooling massage tool for a relaxing ritual.",
    short: "The GHK-Cu Whipped Tallow Balm paired with our cooling Stainless Steel Gua Sha — the balm gives the tool smooth glide for an at-home facial massage.",
    description: ["The whipped balm gives the gua sha just the right amount of slip. A few minutes of gentle massage leaves skin looking refreshed and feeling soft."],
    highlights: ["Full-size GHK-Cu Whipped Tallow Balm (60 g)", "304 stainless steel gua sha with pouch", "Turns your routine into a few relaxing minutes"],
    howTo: "1. Apply a thin layer of balm to clean skin. 2. Holding the gua sha at a low angle, glide gently upward and outward along the jaw, cheeks and forehead 3–5 times per area. 3. Clean the tool with soap and warm water after each use.",
    ingredients: "See each individual product. Full INCI list printed on the balm packaging. Tool: 304 stainless steel, cotton pouch.",
    caution: "For external use only. Use light pressure; do not use the tool on broken, irritated or sunburned skin. Patch test the balm before first use. Keep out of reach of children.",
  },
  {
    id: "hydration-stack",
    name: "The Hydration Stack",
    sub: "Mist + Balm + Lip",
    size: "3-piece stack",
    price: 68,
    category: "Stacks",
    stack: ["hydrating-facial-mist", "ghk-cu-whipped-tallow-balm", "tallow-honey-lip-balm"],
    tagline: "Layer hydration from face to lips.",
    short: "Hydrating Facial Mist, full-size GHK-Cu Whipped Tallow Balm and Tallow & Honey Lip Balm — a layered stack for skin that feels tight or dry.",
    description: ["Mist to prep, balm to seal, lip balm to finish. Misting first helps the balm spread evenly, and the lip balm uses the same grass-fed tallow as our signature balm."],
    highlights: ["Full-size GHK-Cu Whipped Tallow Balm (60 g)", "Hydrating Facial Mist (100 ml)", "Tallow & Honey Lip Balm", "Ideal for dry or dehydrated skin"],
    howTo: "1. Mist face evenly with the Hydrating Facial Mist. 2. While skin is still slightly damp, press in a pea-sized amount of balm. 3. Finish with lip balm. Re-mist throughout the day as needed.",
    ingredients: "See each individual product. Full INCI lists printed on each package.",
    caution: "For external use only. See each product for individual cautions. Patch test before first use. Keep out of reach of children.",
  },
  {
    id: "complete-stack",
    name: "The Complete Stack",
    sub: "Everything Vanta",
    size: "5-piece stack",
    price: 109,
    category: "Stacks",
    badge: "Best Value",
    stack: ["gentle-milk-cleanser", "hydrating-facial-mist", "ghk-cu-whipped-tallow-balm", "tallow-honey-lip-balm", "stainless-gua-sha"],
    tagline: "Every Vanta product in one stack — our biggest savings.",
    short: "The whole line: Gentle Milk Cleanser, Hydrating Facial Mist, full-size GHK-Cu Whipped Tallow Balm, Tallow & Honey Lip Balm and Stainless Steel Gua Sha.",
    description: ["Cleanse, mist, seal, massage and protect — the complete Vanta Skin routine at our deepest stack discount."],
    highlights: ["Full-size GHK-Cu Whipped Tallow Balm (60 g)", "Gentle Milk Cleanser (120 ml)", "Hydrating Facial Mist (100 ml)", "Tallow & Honey Lip Balm", "Stainless Steel Gua Sha with pouch"],
    howTo: "1. Cleanse with the Gentle Milk Cleanser. 2. Mist with the Hydrating Facial Mist. 3. Press in the GHK-Cu Whipped Tallow Balm. 4. Optional: massage with the gua sha. 5. Finish with lip balm.",
    ingredients: "See each individual product. Full INCI lists printed on each package.",
    caution: "For external use only. See each product for individual cautions. Patch test before first use. Keep out of reach of children.",
  },
];

/* Stacks: compare-at price and savings badge are computed from the items in each stack. */
window.PRODUCTS.forEach((p) => {
  if (!p.stack) return;
  const full = p.stack.reduce((a, id) => a + window.PRODUCTS.find((x) => x.id === id).price, 0);
  p.compareAt = full;
  if (!p.badge) p.badge = `Save $${full - p.price}`;
});

/* Simple illustrated jar/tube used for products without photos */
window.productArt = function (p) {
  if (p.images && p.images.length) return `<img src="${p.images[0]}" alt="${p.name}" loading="lazy">`;
  const c = p.color || "#bcd6f2";
  if (p.tool) {
    return `<svg viewBox="0 0 200 200" aria-label="${p.name}"><path d="M40 150 C 30 90, 80 40, 140 40 C 170 40, 175 70, 150 80 C 110 95, 95 120, 90 160 C 85 180, 45 180, 40 150 Z" fill="${c}" stroke="#8a96a8" stroke-width="3"/><circle cx="120" cy="65" r="8" fill="#fff" opacity=".6"/></svg>`;
  }
  if (p.category === "Lip Care") {
    return `<svg viewBox="0 0 200 200" aria-label="${p.name}"><rect x="78" y="30" width="44" height="60" rx="6" fill="#c0c7d1"/><rect x="72" y="86" width="56" height="94" rx="8" fill="#fff" stroke="#0f1b2d" stroke-width="2"/><rect x="72" y="110" width="56" height="40" fill="${c}"/><text x="100" y="135" font-size="11" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="2" fill="#0f1b2d">VANTA</text></svg>`;
  }
  if (p.category === "Cleansers" || p.category === "Toners & Mists") {
    return `<svg viewBox="0 0 200 200" aria-label="${p.name}"><rect x="88" y="16" width="24" height="26" rx="3" fill="#c0c7d1"/><rect x="66" y="40" width="68" height="146" rx="14" fill="${c}" stroke="#0f1b2d" stroke-width="2"/><rect x="74" y="88" width="52" height="58" rx="3" fill="#fff"/><text x="100" y="114" font-size="11" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="2" fill="#0f1b2d">VANTA</text><text x="100" y="128" font-size="6" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="3" fill="#4a5568">SKIN</text></svg>`;
  }
  if (p.stack) {
    const items = p.stack.map((id) => window.PRODUCTS.find((x) => x.id === id)).filter((x) => x && x.images && x.images.length);
    return `<div class="stack-art n${Math.min(items.length, 4)}" role="img" aria-label="${p.name}">${items.slice(0, 4).map((x) => `<img src="${x.images[0]}" alt="" loading="lazy">`).join("")}</div>`;
  }
  if (p.category === "Stacks") {
    return `<svg viewBox="0 0 200 200" aria-label="${p.name}"><rect x="24" y="60" width="152" height="110" rx="6" fill="${c}"/><rect x="24" y="60" width="152" height="22" fill="#0f1b2d"/><rect x="92" y="60" width="16" height="110" fill="#bcd6f2"/><text x="100" y="135" font-size="14" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="4" fill="#fff" font-weight="600">VANTA</text></svg>`;
  }
  return `<svg viewBox="0 0 200 200" aria-label="${p.name}"><rect x="46" y="56" width="108" height="20" rx="4" fill="#c0c7d1"/><rect x="40" y="74" width="120" height="98" rx="12" fill="${c}" stroke="#0f1b2d" stroke-width="2"/><rect x="52" y="96" width="96" height="54" rx="3" fill="#fff"/><text x="100" y="124" font-size="13" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="3" fill="#0f1b2d">VANTA</text><text x="100" y="138" font-size="6" text-anchor="middle" font-family="Inter,sans-serif" letter-spacing="3" fill="#2b6cb0">GHK-Cu</text></svg>`;
};
