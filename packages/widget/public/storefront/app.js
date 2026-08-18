/* PalUp sample storefront — shared client logic (home / product / cart).
 *
 * Fetches the SAME live catalog the assistant is grounded on (GET /storefront/catalog?shop=), renders it,
 * runs a real localStorage cart, and — crucially for the demo — publishes the shopper's cart + page context
 * to `window.PALUP` so the PalUp widget (embedded via the loader) can act on them (cross-sell, cart
 * recovery). ALL merchant-authored text is rendered via textContent (never innerHTML): the JSON is data, and
 * this is the render-side XSS control the catalog endpoint documented. Image URLs were host-validated
 * server-side; we still only ever set them as an <img src>. */
(function () {
  "use strict";
  var SHOP =
    (document.querySelector("script[data-shop]") &&
      document.querySelector("script[data-shop]").getAttribute("data-shop")) ||
    "palup-skincare-jason.myshopify.com";
  var CATALOG_KEY = "palup.storefront.catalog.v1." + SHOP;
  var CART_KEY = "palup.storefront.cart.v1." + SHOP;
  var SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
  var NUMERIC_VARIANT = /^[0-9]{1,20}$/;

  // ---------- cart state (localStorage) ----------
  function readCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var o = raw ? JSON.parse(raw) : [];
      return Array.isArray(o) ? o : [];
    } catch (e) {
      return [];
    }
  }
  function writeCart(items) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch (e) {}
    publishContext();
    renderCartCount();
  }
  function cartCount() {
    return readCart().reduce(function (n, i) {
      return n + (i.quantity || 0);
    }, 0);
  }
  function addToCart(p) {
    var items = readCart();
    var found = items.filter(function (i) {
      return i.productId === p.id;
    })[0];
    if (found) found.quantity += 1;
    else
      items.push({
        productId: p.id,
        variantId: p.variantId,
        handle: p.handle,
        title: p.title,
        price: p.price,
        imageUrl: p.imageUrl,
        quantity: 1,
      });
    writeCart(items);
  }
  function setQty(productId, delta) {
    var items = readCart();
    for (var i = 0; i < items.length; i++) {
      if (items[i].productId === productId) {
        items[i].quantity += delta;
        if (items[i].quantity < 1) items.splice(i, 1);
        break;
      }
    }
    writeCart(items);
  }
  function removeItem(productId) {
    writeCart(
      readCart().filter(function (i) {
        return i.productId !== productId;
      }),
    );
  }

  // ---------- window.PALUP bridge (WS4 host side) ----------
  function pageContext() {
    var base = document.body.getAttribute("data-page-context") || "home";
    if (base === "product") {
      var h = currentHandle(); // hoisted function declaration
      return h ? "product:" + h : "product";
    }
    return base;
  }
  function publishContext() {
    // Whitelist to {productId, quantity} — the loader re-whitelists too, and the server re-derives every
    // display string from the catalog, so nothing else needs to (or should) leave the page.
    var cart = readCart().map(function (i) {
      return { productId: i.productId, quantity: i.quantity };
    });
    window.PALUP = Object.assign(window.PALUP || {}, { cart: cart, pageContext: pageContext() });
    try {
      window.dispatchEvent(new CustomEvent("palup:contextchange"));
    } catch (e) {}
  }

  // ---------- catalog fetch (cached per visit) ----------
  function loadCatalog() {
    try {
      var cached = sessionStorage.getItem(CATALOG_KEY);
      if (cached) return Promise.resolve(JSON.parse(cached));
    } catch (e) {}
    return fetch("/storefront/catalog?shop=" + encodeURIComponent(SHOP))
      .then(function (r) {
        return r.ok ? r.json() : { brandName: "this store", policy: {}, products: [] };
      })
      .then(function (data) {
        try {
          sessionStorage.setItem(CATALOG_KEY, JSON.stringify(data));
        } catch (e) {}
        return data;
      })
      .catch(function () {
        return { brandName: "this store", policy: {}, products: [] };
      });
  }

  // ---------- DOM helpers (textContent only) ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function thumb(imageUrl, alt, cls) {
    var box = el("div", cls || "thumb");
    if (typeof imageUrl === "string" && imageUrl) {
      var img = document.createElement("img");
      img.src = imageUrl;
      img.alt = alt || "";
      img.loading = "lazy";
      box.appendChild(img);
    } else {
      box.appendChild(el("span", "ph", "No image"));
    }
    return box;
  }
  function productHref(p) {
    return "/product/" + encodeURIComponent(p.handle || p.id);
  }

  function setBrand(brandName) {
    var name = brandName || "this store";
    document.querySelectorAll("[data-brand]").forEach(function (n) {
      n.textContent = name;
    });
    if (document.title.indexOf("{brand}") >= 0) document.title = document.title.replace("{brand}", name);
  }
  function setPolicy(policy) {
    var p = policy || {};
    var r = document.querySelector("[data-policy-returns]");
    var s = document.querySelector("[data-policy-shipping]");
    if (r && p.returns) r.textContent = p.returns;
    if (s && p.shipping) s.textContent = p.shipping;
  }

  // ---------- per-page renderers ----------
  function renderHome(cat) {
    var grid = document.getElementById("grid");
    if (!grid) return;
    grid.textContent = "";
    var products = cat.products || [];
    if (!products.length) {
      grid.appendChild(el("p", "empty", "No products are available right now."));
      grid.setAttribute("data-ready", "1");
      return;
    }
    products.forEach(function (p) {
      var a = document.createElement("a");
      a.className = "card";
      a.href = productHref(p);
      a.appendChild(thumb(p.imageUrl, p.title));
      var body = el("div", "body");
      body.appendChild(el("span", "title", p.title));
      body.appendChild(el("span", "price", p.price || ""));
      a.appendChild(body);
      grid.appendChild(a);
    });
    grid.setAttribute("data-ready", "1");
  }

  function currentHandle() {
    var m = location.pathname.match(/\/product\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function renderProduct(cat) {
    var mount = document.getElementById("pdp");
    if (!mount) return;
    var key = currentHandle();
    var products = cat.products || [];
    var p =
      products.filter(function (x) {
        return x.handle === key;
      })[0] ||
      products.filter(function (x) {
        return x.id === key;
      })[0];
    mount.textContent = "";
    if (!p) {
      mount.appendChild(el("p", "empty", "Sorry — we couldn't find that product."));
      mount.setAttribute("data-ready", "notfound");
      return;
    }
    document.title = p.title + " — " + (cat.brandName || "Store");
    mount.appendChild(thumb(p.imageUrl, p.title, "media"));
    var info = el("div", "info");
    info.appendChild(el("h1", null, p.title));
    info.appendChild(el("p", "price", p.price || ""));
    if (p.availableForSale === false) info.appendChild(el("p", "avail", "Currently unavailable"));
    else if (p.availableForSale === true) info.appendChild(el("p", "avail", "In stock"));
    if (p.description) info.appendChild(el("p", "desc", p.description));
    var add = el("button", "btn", "Add to cart");
    add.type = "button";
    add.setAttribute("data-testid", "add-to-cart");
    if (p.availableForSale === false) add.disabled = true;
    add.addEventListener("click", function () {
      addToCart(p);
      add.textContent = "Added ✓";
      setTimeout(function () {
        add.textContent = "Add to cart";
      }, 1400);
    });
    info.appendChild(add);
    if (Array.isArray(p.ingredients) && p.ingredients.length) {
      var ing = el("div", "ingredients");
      ing.appendChild(el("h2", null, "Ingredients"));
      ing.appendChild(el("p", null, p.ingredients.join(", ")));
      info.appendChild(ing);
    }
    mount.appendChild(info);
    mount.setAttribute("data-ready", "1");
  }

  function checkoutUrl(items) {
    var parts = items
      .filter(function (i) {
        return typeof i.variantId === "string" && NUMERIC_VARIANT.test(i.variantId) && i.quantity >= 1;
      })
      .map(function (i) {
        return i.variantId + ":" + Math.min(i.quantity, 99);
      });
    if (!parts.length || !SHOP_HOST.test(SHOP)) return null;
    return "https://" + SHOP + "/cart/" + parts.join(",");
  }
  function renderCart() {
    var mount = document.getElementById("cart");
    if (!mount) return;
    mount.textContent = "";
    var items = readCart();
    if (!items.length) {
      mount.appendChild(el("p", "empty", "Your cart is empty."));
      var browse = document.createElement("a");
      browse.className = "btn btn-outline";
      browse.href = "/";
      browse.textContent = "Browse products";
      mount.appendChild(browse);
      mount.setAttribute("data-ready", "empty");
      return;
    }
    var list = el("ul", "cart-list");
    list.setAttribute("data-testid", "cart-list");
    items.forEach(function (i) {
      var li = el("li", "cart-row");
      li.appendChild(thumb(i.imageUrl, i.title));
      var mid = el("div");
      mid.appendChild(el("div", "title", i.title));
      mid.appendChild(el("div", "price", i.price || ""));
      var qty = el("div", "qty");
      var dec = el("button", null, "−");
      dec.type = "button";
      dec.setAttribute("aria-label", "Decrease quantity of " + i.title);
      dec.addEventListener("click", function () {
        setQty(i.productId, -1);
        renderCart();
      });
      var count = el("span", null, String(i.quantity));
      var inc = el("button", null, "+");
      inc.type = "button";
      inc.setAttribute("aria-label", "Increase quantity of " + i.title);
      inc.addEventListener("click", function () {
        setQty(i.productId, 1);
        renderCart();
      });
      qty.appendChild(dec);
      qty.appendChild(count);
      qty.appendChild(inc);
      mid.appendChild(qty);
      li.appendChild(mid);
      var rm = el("button", "remove", "Remove");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + i.title);
      rm.addEventListener("click", function () {
        removeItem(i.productId);
        renderCart();
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
    mount.appendChild(list);
    var foot = el("div", "cart-foot");
    var href = checkoutUrl(items);
    var co = document.createElement("a");
    co.className = "btn";
    co.setAttribute("data-testid", "checkout");
    co.textContent = "Checkout on Shopify";
    co.rel = "noopener";
    if (href) {
      co.href = href;
    } else {
      co.setAttribute("aria-disabled", "true");
      co.style.pointerEvents = "none";
      co.style.opacity = "0.5";
    }
    foot.appendChild(co);
    mount.appendChild(foot);
    mount.setAttribute("data-ready", "1");
  }

  function renderCartCount() {
    var n = cartCount();
    document.querySelectorAll("[data-cart-count]").forEach(function (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    });
  }

  // ---------- boot ----------
  publishContext(); // set window.PALUP before the loader script reads it on palup:ready
  renderCartCount();
  loadCatalog().then(function (cat) {
    setBrand(cat.brandName);
    setPolicy(cat.policy);
    var page = document.body.getAttribute("data-page");
    if (page === "home") renderHome(cat);
    else if (page === "product") renderProduct(cat);
    else if (page === "cart") renderCart();
    // Rendering is done — clear the loading state so assistive tech isn't left told the region is busy.
    document.querySelectorAll('[aria-busy="true"]').forEach(function (n) {
      n.setAttribute("aria-busy", "false");
    });
  });
})();
