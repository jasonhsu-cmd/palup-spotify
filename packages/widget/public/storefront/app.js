/* PalUp sample storefront — shared client logic (home / product / cart).
 *
 * Fetches the live catalog PAGE BY PAGE from GET /storefront/catalog?shop=&cursor= (durable for any catalog
 * size — the assistant grounds on the same catalog via retrieval). Runs a real localStorage cart and
 * publishes the shopper's cart + page context to `window.PALUP` so the embedded PalUp widget can act on them.
 * ALL merchant text is rendered via textContent (never innerHTML) — the render-side XSS control. Image URLs
 * were host-validated server-side; we still only ever set them as an <img src>. */
(function () {
  "use strict";
  var SHOP =
    (document.querySelector("script[data-shop]") &&
      document.querySelector("script[data-shop]").getAttribute("data-shop")) ||
    "palup-skincare-jason.myshopify.com";
  var CART_KEY = "palup.storefront.cart.v1." + SHOP;
  var STASH_PREFIX = "palup.storefront.product.v1.";
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

  // ---------- window.PALUP bridge (host side; loader forwards to the widget) ----------
  function pageContext() {
    var base = document.body.getAttribute("data-page-context") || "home";
    if (base === "product") {
      var h = currentHandle();
      return h ? "product:" + h : "product";
    }
    return base;
  }
  function publishContext() {
    var cart = readCart().map(function (i) {
      return { productId: i.productId, quantity: i.quantity };
    });
    window.PALUP = Object.assign(window.PALUP || {}, { cart: cart, pageContext: pageContext() });
    try {
      window.dispatchEvent(new CustomEvent("palup:contextchange"));
    } catch (e) {}
  }

  // ---------- catalog paging (cursor-based, durable for any size) ----------
  function fetchPage(cursor) {
    var url = "/storefront/catalog?shop=" + encodeURIComponent(SHOP);
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
    return fetch(url)
      .then(function (r) {
        return r.ok ? r.json() : { brandName: "this store", policy: {}, products: [] };
      })
      .catch(function () {
        return { brandName: "this store", policy: {}, products: [] };
      });
  }
  // Stash a product so a home→PDP click always resolves without re-crawling the catalog.
  function stash(p) {
    try {
      sessionStorage.setItem(STASH_PREFIX + (p.handle || p.id), JSON.stringify(p));
    } catch (e) {}
  }
  function readStash(key) {
    try {
      var raw = sessionStorage.getItem(STASH_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
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
  function productCard(p) {
    var a = document.createElement("a");
    a.className = "card";
    a.href = productHref(p);
    a.addEventListener("click", function () {
      stash(p);
    });
    a.appendChild(thumb(p.imageUrl, p.title));
    var body = el("div", "body");
    body.appendChild(el("span", "title", p.title));
    body.appendChild(el("span", "price", p.price || ""));
    a.appendChild(body);
    return a;
  }

  // ---------- home (paginated grid + load more) ----------
  function renderHome() {
    var grid = document.getElementById("grid");
    if (!grid) return;
    var moreBtn = null;
    var cursor = null;
    var loading = false;

    function appendPage(data) {
      var products = data.products || [];
      products.forEach(function (p) {
        grid.appendChild(productCard(p));
      });
      cursor = data.nextCursor || null;
      if (!grid.children.length) grid.appendChild(el("p", "empty", "No products are available right now."));
      grid.setAttribute("data-ready", "1");
      grid.setAttribute("aria-busy", "false");
      if (moreBtn) moreBtn.hidden = !cursor;
    }
    function loadMore() {
      if (loading || !cursor) return;
      loading = true;
      moreBtn.disabled = true;
      moreBtn.textContent = "Loading…";
      fetchPage(cursor).then(function (data) {
        appendPage(data);
        loading = false;
        moreBtn.disabled = false;
        moreBtn.textContent = "Load more";
      });
    }

    fetchPage(null).then(function (data) {
      setBrand(data.brandName);
      setPolicy(data.policy);
      // build the "Load more" control after the grid, shown only when there is a next page
      var wrap = document.getElementById("grid-more");
      if (wrap) {
        moreBtn = el("button", "btn btn-outline", "Load more");
        moreBtn.type = "button";
        moreBtn.setAttribute("data-testid", "load-more");
        moreBtn.hidden = true;
        moreBtn.addEventListener("click", loadMore);
        wrap.appendChild(moreBtn);
      }
      appendPage(data);
    });
  }

  // ---------- product detail ----------
  function currentHandle() {
    var m = location.pathname.match(/\/product\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  // Resolve EXACTLY ONE product by handle server-side — durable for any catalog size. The grid pages, but a
  // direct / SEO / ad PDP landing (no home→click stash) must resolve a product beyond page 1 too, which a
  // page-1-only scan cannot. Returns null on any non-ok/absent so the caller falls back gracefully.
  function fetchProductByHandle(handle) {
    var url = "/storefront/product?shop=" + encodeURIComponent(SHOP) + "&handle=" + encodeURIComponent(handle);
    return fetch(url)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        return d && d.product ? d.product : null;
      })
      .catch(function () {
        return null;
      });
  }
  function renderProductInto(mount, p, brandName) {
    document.title = p.title + " — " + (brandName || "Store");
    mount.textContent = "";
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
    mount.setAttribute("aria-busy", "false");
  }
  function renderProduct() {
    var mount = document.getElementById("pdp");
    if (!mount) return;
    var key = currentHandle();
    var stashed = readStash(key);
    if (stashed) {
      // brand may not be set yet; fetch page 1 only for brand/policy chrome, render immediately from stash
      renderProductInto(mount, stashed, null);
      fetchPage(null).then(function (data) {
        setBrand(data.brandName);
        setPolicy(data.policy);
        document.title = stashed.title + " — " + (data.brandName || "Store");
      });
      return;
    }
    // Direct URL (no prior click): resolve the ONE product server-side by handle first (works for any
    // catalog size, unlike a page-1-only scan). Fall back to the first-page scan if that endpoint is
    // unavailable, then to the honest not-found.
    fetchProductByHandle(key).then(function (product) {
      if (product) {
        renderProductInto(mount, product, null);
        fetchPage(null).then(function (data) {
          setBrand(data.brandName);
          setPolicy(data.policy);
          document.title = product.title + " — " + (data.brandName || "Store");
        });
        return;
      }
      fetchPage(null).then(function (data) {
        setBrand(data.brandName);
        setPolicy(data.policy);
        var products = data.products || [];
        var p =
          products.filter(function (x) {
            return x.handle === key;
          })[0] ||
          products.filter(function (x) {
            return x.id === key;
          })[0];
        if (p) {
          renderProductInto(mount, p, data.brandName);
        } else {
          mount.textContent = "";
          mount.appendChild(el("p", "empty", "Sorry — we couldn't find that product from here."));
          var back = document.createElement("a");
          back.className = "btn btn-outline";
          back.href = "/";
          back.textContent = "Browse all products";
          mount.appendChild(back);
          mount.setAttribute("data-ready", "notfound");
          mount.setAttribute("aria-busy", "false");
        }
      });
    });
  }

  // ---------- cart ----------
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
      mount.setAttribute("aria-busy", "false");
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
    co.target = "_blank";
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
    mount.setAttribute("aria-busy", "false");
  }

  function renderCartCount() {
    var n = cartCount();
    document.querySelectorAll("[data-cart-count]").forEach(function (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    });
  }

  // ---------- boot ----------
  publishContext(); // set window.PALUP before the loader reads it
  renderCartCount();
  var page = document.body.getAttribute("data-page");
  if (page === "home") renderHome();
  else if (page === "product") renderProduct();
  else if (page === "cart") {
    renderCart();
    fetchPage(null).then(function (data) {
      setBrand(data.brandName);
      setPolicy(data.policy);
    });
  }
})();
