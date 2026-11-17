import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Role = "customer" | "vendor" | "admin";
type Auth = { username: string; role: Role; csrf_token: string };
type Product = {
  id: number;
  vendor_id: number;
  vendor_name: string;
  name: string;
  description: string;
  category: string;
  price_cents: number;
  image_url: string;
  stock: number;
  active: boolean;
};
type Cart = { items: { product: Product; quantity: number; line_total_cents: number }[]; total_cents: number };
type Order = {
  id: number;
  customer_name: string;
  shipping_address: string;
  status: string;
  total_cents: number;
  created_at: number;
  items: { product_name: string; quantity: number; unit_price_cents: number; vendor_name: string; status: string }[];
};
type Payout = { gross_sales_cents: number; platform_fee_cents: number; estimated_payout_cents: number; order_count: number; units_sold: number };
type AdminSummary = { customers: number; vendors: number; products: number; orders: number; gross_sales_cents: number; estimated_vendor_payouts_cents: number };
type AdminUser = { id: number; username: string; role: Role };
type ProductInput = { name: string; description: string; category: string; price_cents: number; image_url: string; stock: number };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit, csrfToken?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
    throw new ApiError(typeof detail === "string" ? detail : `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const dateLabel = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const statusClass = (status: string) => `status status-${status}`;
const categoryImages: Record<string, string> = {
  Home: "photo-1600210492486-724fe5c67fb0",
  Apparel: "photo-1529139574466-a303027c1d8b",
  Tech: "photo-1498049794561-7780e7231661",
  Wellness: "photo-1540555700478-4be289fbecef",
  Art: "photo-1579783902614-a3fb3927b6a5",
};

function ProductImage({ product }: { product: Product }) {
  const fallback = `https://images.unsplash.com/${categoryImages[product.category] ?? "photo-1542291026-7eec264c27ff"}?auto=format&fit=crop&w=800&q=80`;
  return <img className="product-image" src={product.image_url || fallback} alt={product.name} loading="lazy" />;
}

export default function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cart, setCart] = useState<Cart>({ items: [], total_cents: 0 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [vendorProducts, setVendorProducts] = useState<Product[]>([]);
  const [payout, setPayout] = useState<Payout | null>(null);
  const [adminSummary, setAdminSummary] = useState<AdminSummary | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [view, setView] = useState("shop");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [cartOpen, setCartOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registerRole, setRegisterRole] = useState<"customer" | "vendor">("customer");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [productForm, setProductForm] = useState({ name: "", description: "", category: "Home", price: "", image_url: "", stock: "12" });

  const loadShop = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (category !== "All") params.set("category", category);
    const suffix = params.size ? `?${params.toString()}` : "";
    const [listed, categoryList] = await Promise.all([
      request<Product[]>(`/products${suffix}`),
      request<string[]>("/products/categories"),
    ]);
    setProducts(listed);
    setCategories(categoryList);
  }, [search, category]);

  const loadRoleData = useCallback(async (current: Auth) => {
    if (current.role === "customer") {
      const [nextCart, nextOrders] = await Promise.all([request<Cart>("/cart"), request<Order[]>("/orders")]);
      setCart(nextCart);
      setOrders(nextOrders);
    } else if (current.role === "vendor") {
      const [owned, nextOrders, nextPayout] = await Promise.all([
        request<Product[]>("/vendor/products"),
        request<Order[]>("/vendor/orders"),
        request<Payout>("/vendor/analytics"),
      ]);
      setVendorProducts(owned);
      setOrders(nextOrders);
      setPayout(nextPayout);
    } else {
      const [summary, allOrders, users] = await Promise.all([
        request<AdminSummary>("/admin/summary"),
        request<Order[]>("/admin/orders"),
        request<AdminUser[]>("/admin/users"),
      ]);
      setAdminSummary(summary);
      setOrders(allOrders);
      setAdminUsers(users);
    }
  }, []);

  const loadEverything = useCallback(async (current: Auth | null) => {
    await loadShop();
    if (current) await loadRoleData(current);
  }, [loadRoleData, loadShop]);

  useEffect(() => {
    void loadShop().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load products"));
  }, [loadShop]);

  useEffect(() => {
    void request<Auth>("/auth/me")
      .then(async (current) => {
        setAuth(current);
        await loadRoleData(current);
      })
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) setError(err instanceof Error ? err.message : "Could not connect to the server");
      })
      .finally(() => setLoading(false));
  }, [loadRoleData]);

  const cartCount = useMemo(() => cart.items.reduce((sum, item) => sum + item.quantity, 0), [cart]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const current = await request<Auth>(isRegistering ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password, ...(isRegistering ? { role: registerRole } : {}) }),
      });
      setAuth(current);
      setPassword("");
      setView(current.role === "customer" ? "shop" : current.role === "vendor" ? "seller" : "admin");
      await loadEverything(current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not authenticate");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!auth) return;
    setBusy(true);
    try {
      await request<void>("/auth/logout", { method: "POST" }, auth.csrf_token);
      setAuth(null);
      setCart({ items: [], total_cents: 0 });
      setUsername("");
      setView("shop");
      setNotice("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  async function addToCart(product: Product) {
    if (!auth || auth.role !== "customer") {
      setNotice("Sign in with a customer account to add items to your bag.");
      return;
    }
    try {
      setError("");
      setCart(await request<Cart>(`/cart/items/${product.id}`, { method: "POST", body: JSON.stringify({ quantity: 1 }) }, auth.csrf_token));
      setNotice(`${product.name} added to your bag.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add item");
    }
  }

  async function changeQuantity(productId: number, quantity: number) {
    if (!auth) return;
    try {
      if (quantity < 1) {
        setCart(await request<Cart>(`/cart/items/${productId}`, { method: "DELETE" }, auth.csrf_token));
      } else {
        setCart(await request<Cart>(`/cart/items/${productId}`, { method: "PATCH", body: JSON.stringify({ quantity }) }, auth.csrf_token));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update your bag");
    }
  }

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setBusy(true);
    try {
      await request<Order>("/orders", { method: "POST", body: JSON.stringify({ shipping_address: address }) }, auth.csrf_token);
      setAddress("");
      setCartOpen(false);
      setNotice("Order placed. This demo does not charge a payment method.");
      await loadRoleData(auth);
      await loadShop();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not place your order");
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setBusy(true);
    try {
      const input: ProductInput = {
        name: productForm.name.trim(),
        description: productForm.description.trim(),
        category: productForm.category,
        price_cents: Math.round(Number(productForm.price) * 100),
        image_url: productForm.image_url.trim(),
        stock: Number(productForm.stock),
      };
      await request<Product>("/vendor/products", { method: "POST", body: JSON.stringify(input) }, auth.csrf_token);
      setProductForm({ name: "", description: "", category: "Home", price: "", image_url: "", stock: "12" });
      setNotice("Your product is live in the marketplace.");
      await loadRoleData(auth);
      await loadShop();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create product");
    } finally {
      setBusy(false);
    }
  }

  async function removeProduct(product: Product) {
    if (!auth) return;
    try {
      await request<void>(`/vendor/products/${product.id}`, { method: "DELETE" }, auth.csrf_token);
      await loadRoleData(auth);
      await loadShop();
      setNotice(`${product.name} has been archived.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive product");
    }
  }

  async function updateOrder(orderId: number, nextStatus: string) {
    if (!auth) return;
    const base = auth.role === "admin" ? "/admin" : "/vendor";
    try {
      await request<Order>(`${base}/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) }, auth.csrf_token);
      await loadRoleData(auth);
      setNotice(`Order #${orderId} updated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update order");
    }
  }

  async function changeUserRole(userId: number, role: Role) {
    if (!auth) return;
    try {
      await request<AdminUser>(`/admin/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }, auth.csrf_token);
      await loadRoleData(auth);
      setNotice("Account role updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update account role");
    }
  }

  if (loading) {
    return <main className="loading-screen"><div className="brand-mark">m</div><p>Setting up your Marketday...</p></main>;
  }

  if (!auth) {
    return (
      <main className="auth-page">
        <section className="auth-visual">
          <a className="brand light-brand" href="#" onClick={() => setView("shop")}><span className="brand-mark">m</span> marketday</a>
          <div className="auth-art"><span>Objects with<br />a little more<br /><em>meaning.</em></span></div>
          <p>Independent makers. Thoughtful finds. A better kind of marketplace.</p>
        </section>
        <section className="auth-side">
          <div className="auth-box">
            <div className="eyebrow">{isRegistering ? "JOIN THE MARKETPLACE" : "WELCOME BACK"}</div>
            <h1>{isRegistering ? "Find your place here." : "Good things await."}</h1>
            <p className="auth-intro">{isRegistering ? "Create an account to shop small or start selling." : "Sign in to pick up right where you left off."}</p>
            <form className="auth-form" onSubmit={submitAuth}>
              <label htmlFor="username">Username</label>
              <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]{3,32}" autoComplete="username" required />
              {isRegistering && <><label htmlFor="role">I want to</label><select id="role" value={registerRole} onChange={(event) => setRegisterRole(event.target.value as "customer" | "vendor")}><option value="customer">Shop as a customer</option><option value="vendor">Sell as a vendor</option></select></>}
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete={isRegistering ? "new-password" : "current-password"} required />
              <span className="field-note">Use 12–128 characters.</span>
              {error && <div className="alert error-alert" role="alert">{error}</div>}
              <button className="button button-dark full-button" disabled={busy}>{busy ? "One moment..." : isRegistering ? "Create my account" : "Sign in"}</button>
            </form>
            <p className="switch-auth">{isRegistering ? "Already have an account?" : "New to Marketday?"} <button type="button" onClick={() => { setIsRegistering((value) => !value); setError(""); }}> {isRegistering ? "Sign in" : "Create an account"}</button></p>
            <p className="auth-privacy">By continuing, you agree to our community-first terms.</p>
          </div>
        </section>
      </main>
    );
  }

  const navItems = auth.role === "customer"
    ? [["shop", "Discover"], ["orders", "My orders"]]
    : auth.role === "vendor"
      ? [["seller", "Overview"], ["seller-orders", "Orders"]]
      : [["admin", "Overview"], ["admin-orders", "Orders"], ["admin-users", "Accounts"]];

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setView(auth.role === "customer" ? "shop" : auth.role === "vendor" ? "seller" : "admin"); }}><span className="brand-mark">m</span> marketday</a>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map(([key, label]) => <button key={key} className={view === key ? "nav-link active" : "nav-link"} onClick={() => { setView(key); setError(""); setNotice(""); }}>{label}</button>)}
        </nav>
        <div className="top-actions">
          <span className="account-chip"><span className="avatar">{auth.username.charAt(0).toUpperCase()}</span><span>{auth.username}</span><small>{auth.role}</small></span>
          {auth.role === "customer" && <button className="bag-button" onClick={() => setCartOpen(true)} aria-label={`Open bag, ${cartCount} items`}>Bag <span>{cartCount}</span></button>}
          <button className="sign-out" onClick={() => void signOut()} disabled={busy}>Sign out</button>
        </div>
      </header>

      <main className="content">
        {error && <div className="alert error-alert" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        {notice && <div className="alert notice-alert" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}

        {view === "shop" && auth.role === "customer" && (
          <>
            <section className="hero">
              <div className="hero-copy"><span className="eyebrow">THE GOOD FINDS EDIT</span><h1>Made with care.<br /><em>Found by you.</em></h1><p>Discover pieces worth keeping, made by independent shops and creative people.</p><button className="button button-dark" onClick={() => document.getElementById("collection")?.scrollIntoView({ behavior: "smooth" })}>Explore the collection <span>↘</span></button><div className="hero-note"><span className="tiny-star">✳</span> A marketplace for independent makers</div></div>
              <div className="hero-image"><div className="image-caption"><span>THE EVERYDAY OBJECTS EDIT</span><b>Thoughtful things<br />for slower living.</b></div></div>
              <div className="hero-number">01 <span>— 04</span></div>
            </section>
            <section className="benefits-strip"><span>✳ Curated from independent makers</span><i></i><span>↗ Every order supports a small business</span><i></i><span>◷ Easy, transparent order tracking</span></section>
            <section className="collection" id="collection">
              <div className="section-heading"><div><span className="eyebrow">THE MARKETPLACE</span><h2>Find your next favorite.</h2><p>Good design, good people, good things.</p></div><div className="search-wrap"><span>⌕</span><input aria-label="Search products" placeholder="Search the market..." value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
              <div className="category-row"><button className={category === "All" ? "category-pill selected" : "category-pill"} onClick={() => setCategory("All")}>Everything <span>{products.length}</span></button>{categories.map((item) => <button key={item} className={category === item ? "category-pill selected" : "category-pill"} onClick={() => setCategory(item)}>{item}</button>)}</div>
              {products.length ? <div className="product-grid">{products.map((product, index) => <article className="product-card" key={product.id}><div className="product-photo"><ProductImage product={product} /><span className="product-index">0{(index % 8) + 1}</span><button className="quick-add" onClick={() => void addToCart(product)} aria-label={`Add ${product.name} to bag`}>+</button></div><div className="product-details"><div><span className="product-category">{product.category} · by {product.vendor_name}</span><h3>{product.name}</h3></div><strong>{money(product.price_cents)}</strong></div><p className="product-description">{product.description || "A considered piece, made to be part of your everyday."}</p></article>)}</div> : <div className="empty-products"><span>✳</span><h3>Nothing on this shelf yet.</h3><p>Try another search or check back soon for new finds.</p></div>}
            </section>
            <section className="maker-banner"><div><span className="eyebrow">A PLACE FOR GOOD IDEAS</span><h2>Small shops make<br />the world more <em>interesting.</em></h2></div><p>Marketday brings makers and their communities together, one meaningful find at a time.</p></section>
          </>
        )}

        {view === "orders" && auth.role === "customer" && <section className="dashboard-section"><SectionTitle eyebrow="YOUR MARKETDAY" title="Order journal" note="A little something to look forward to." />{orders.length ? <div className="order-list">{orders.map((order) => <OrderCard key={order.id} order={order} />)}</div> : <EmptyState title="Your next good find is out there." text="Orders you place will show up here." action="Discover the market" onClick={() => setView("shop")} />}</section>}

        {view === "seller" && auth.role === "vendor" && (
          <section className="dashboard-section"><SectionTitle eyebrow="YOUR STUDIO" title={`Good to see you, ${auth.username}.`} note="A clear view of your shop, sales, and next steps." />
            {payout && <div className="metric-grid"><Metric label="Estimated payout" value={money(payout.estimated_payout_cents)} detail="After 10% marketplace fee" /><Metric label="Gross sales" value={money(payout.gross_sales_cents)} detail={`${payout.units_sold} items sold`} /><Metric label="Orders" value={String(payout.order_count)} detail="Across your products" /></div>}
            <div className="vendor-layout"><section className="panel product-manager"><div className="panel-heading"><div><span className="eyebrow">YOUR CATALOG</span><h2>Products <span className="count-badge">{vendorProducts.length}</span></h2></div></div>{vendorProducts.length ? <div className="seller-product-list">{vendorProducts.map((product) => <div className="seller-product" key={product.id}><ProductImage product={product} /><div className="seller-product-info"><strong>{product.name}</strong><span>{product.category} · {money(product.price_cents)}</span></div><span className={product.active ? "stock-label" : "archived-label"}>{product.active ? `${product.stock} in stock` : "Archived"}</span>{product.active && <button className="text-action" onClick={() => void removeProduct(product)}>Archive</button>}</div>)}</div> : <div className="compact-empty">Your shop is ready. Add your first product.</div>}</section>
              <form className="panel product-form" onSubmit={(event) => void createProduct(event)}><span className="eyebrow">ADD SOMETHING GOOD</span><h2>New product</h2><label>Product name<input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} minLength={2} maxLength={120} required /></label><label>Short description<textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} maxLength={1000} rows={3} /></label><div className="form-row"><label>Category<select value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })}>{["Home", "Apparel", "Tech", "Wellness", "Art", "Other"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Price (USD)<input type="number" min="0.01" step="0.01" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} required /></label></div><div className="form-row"><label>Available stock<input type="number" min="0" max="1000000" value={productForm.stock} onChange={(event) => setProductForm({ ...productForm, stock: event.target.value })} required /></label><label>Image URL<input type="url" placeholder="https://..." value={productForm.image_url} onChange={(event) => setProductForm({ ...productForm, image_url: event.target.value })} /></label></div><button className="button button-dark full-button" disabled={busy}>Publish product <span>↗</span></button></form></div>
          </section>
        )}

        {view === "seller-orders" && auth.role === "vendor" && <section className="dashboard-section"><SectionTitle eyebrow="FULFILLMENT" title="Orders to make their way." note="Mark an order shipped when it leaves your studio." /><OrderList orders={orders} onStatus={updateOrder} vendor vendorName={auth.username} /></section>}

        {view === "admin" && auth.role === "admin" && <section className="dashboard-section"><SectionTitle eyebrow="MARKETDAY OPERATIONS" title="The big picture." note="A snapshot of the marketplace and the people behind it." />{adminSummary && <div className="metric-grid admin-metrics"><Metric label="Gross marketplace sales" value={money(adminSummary.gross_sales_cents)} detail="Excluding cancelled orders" /><Metric label="Est. vendor payouts" value={money(adminSummary.estimated_vendor_payouts_cents)} detail="90% of eligible gross sales" /><Metric label="Orders" value={String(adminSummary.orders)} detail={`${adminSummary.products} active products`} /><Metric label="Community" value={`${adminSummary.vendors} vendors`} detail={`${adminSummary.customers} customers`} /></div>}<div className="panel admin-latest"><div className="panel-heading"><div><span className="eyebrow">LATEST ACTIVITY</span><h2>Recent orders</h2></div><button className="text-action" onClick={() => setView("admin-orders")}>All orders ↗</button></div><OrderList orders={orders.slice(0, 4)} onStatus={updateOrder} /></div></section>}

        {view === "admin-orders" && auth.role === "admin" && <section className="dashboard-section"><SectionTitle eyebrow="MARKETDAY OPERATIONS" title="Every order, one place." note="Review activity and keep fulfillment moving." /><OrderList orders={orders} onStatus={updateOrder} admin /></section>}

        {view === "admin-users" && auth.role === "admin" && <section className="dashboard-section"><SectionTitle eyebrow="COMMUNITY MANAGEMENT" title="People make the market." note="Review accounts and assign customer, vendor, or administrator access." /><div className="panel users-panel"><div className="users-header"><span>ACCOUNT</span><span>ROLE</span><span>ACCESS</span></div>{adminUsers.map((user) => <div className="user-row" key={user.id}><span className="user-identity"><span className="avatar">{user.username.charAt(0).toUpperCase()}</span>{user.username}</span><span className={user.role === "admin" ? "role-badge admin-role" : "role-badge"}>{user.role}</span><select aria-label={`Role for ${user.username}`} value={user.role} disabled={user.id === adminUsers.find((item) => item.username === auth.username)?.id} onChange={(event) => void changeUserRole(user.id, event.target.value as Role)}><option value="customer">Customer</option><option value="vendor">Vendor</option><option value="admin">Admin</option></select></div>)}</div></section>}
      </main>

      <footer className="site-footer"><a className="brand" href="#" onClick={(event) => event.preventDefault()}><span className="brand-mark">m</span> marketday</a><span>Good things, made by good people.</span><span>© 2025 Marketday Marketplace</span></footer>

      {cartOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false); }}><aside className="cart-drawer" aria-label="Shopping bag"><div className="drawer-heading"><div><span className="eyebrow">YOUR MARKETDAY BAG</span><h2>A few good things.</h2></div><button className="close-button" onClick={() => setCartOpen(false)} aria-label="Close bag">×</button></div>{cart.items.length ? <><div className="cart-items">{cart.items.map((item) => <div className="cart-item" key={item.product.id}><ProductImage product={item.product} /><div className="cart-item-info"><strong>{item.product.name}</strong><span>{money(item.product.price_cents)} · {item.product.vendor_name}</span>{!item.product.active && <span className="archived-label">No longer available — remove to check out</span>}<div className="quantity-control"><button onClick={() => void changeQuantity(item.product.id, item.quantity - 1)} aria-label="Remove one">−</button><span>{item.quantity}</span><button disabled={!item.product.active || item.quantity >= item.product.stock} onClick={() => void changeQuantity(item.product.id, item.quantity + 1)} aria-label="Add one">+</button></div></div><b>{money(item.line_total_cents)}</b></div>)}</div><div className="cart-summary"><div><span>Subtotal</span><b>{money(cart.total_cents)}</b></div><p>Shipping and any applicable taxes are calculated by the seller.</p><form onSubmit={(event) => void checkout(event)}><label htmlFor="shipping-address">Shipping address</label><textarea id="shipping-address" rows={3} minLength={8} maxLength={500} placeholder="Street, city, region, postal code" value={address} onChange={(event) => setAddress(event.target.value)} required /><button className="button button-dark full-button" disabled={busy || cart.items.some((item) => !item.product.active)}>{busy ? "Placing order..." : "Place demo order · " + money(cart.total_cents)}</button></form><small>Demo checkout only — no payment is collected.</small></div></> : <EmptyState title="Your bag is taking a breather." text="Add something lovely from the marketplace." action="Keep exploring" onClick={() => setCartOpen(false)} />}</aside></div>}
    </div>
  );
}

function SectionTitle({ eyebrow, title, note }: { eyebrow: string; title: string; note: string }) {
  return <div className="dashboard-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{note}</p></div>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function EmptyState({ title, text, action, onClick }: { title: string; text: string; action: string; onClick: () => void }) {
  return <div className="empty-products empty-dashboard"><span>✳</span><h3>{title}</h3><p>{text}</p><button className="button button-outline" onClick={onClick}>{action}</button></div>;
}

function OrderCard({ order }: { order: Order }) {
  return <article className="order-card"><div className="order-top"><div><span className="eyebrow">ORDER #{String(order.id).padStart(5, "0")}</span><h3>{dateLabel(order.created_at)}</h3></div><span className={statusClass(order.status)}>{order.status}</span></div><div className="order-lines">{order.items.map((item, index) => <div className="order-line" key={`${order.id}-${index}`}><span>{item.quantity} × {item.product_name}</span><small>by {item.vendor_name} · {item.status}</small><b>{money(item.unit_price_cents * item.quantity)}</b></div>)}</div><div className="order-bottom"><span>{order.shipping_address}</span><strong>{money(order.total_cents)}</strong></div></article>;
}

function OrderList({ orders, onStatus, vendor = false, admin = false, vendorName }: { orders: Order[]; onStatus: (id: number, status: string) => void; vendor?: boolean; admin?: boolean; vendorName?: string }) {
  if (!orders.length) return <div className="compact-empty">No orders here yet. Check back when the next one arrives.</div>;
  return <div className="order-list">{orders.map((order) => <div className="managed-order" key={order.id}><OrderCard order={order} />{(vendor || admin) && <div className="order-controls">{vendor && <span>Customer: <b>{order.customer_name}</b></span>}{admin && <span>Customer: <b>{order.customer_name}</b></span>}<label htmlFor={`status-${order.id}`}>Update status</label><select id={`status-${order.id}`} value={vendor ? order.items.find((item) => item.vendor_name === vendorName)?.status ?? order.status : order.status} onChange={(event) => onStatus(order.id, event.target.value)}><option value="processing">Processing</option><option value="shipped">Shipped</option><option value="delivered">Delivered</option>{admin && <option value="cancelled">Cancelled</option>}</select></div>}</div>)}</div>;
}
