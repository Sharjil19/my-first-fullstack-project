# Marketday

A multi-vendor marketplace starter built with React, TypeScript, FastAPI, SQLAlchemy, and PostgreSQL. Customers can discover products, manage a shopping bag, place demo orders, and track fulfillment. Vendors can publish and archive products, update fulfillment, and review estimated payouts. Administrators can review marketplace activity and manage account roles.

## Requirements

- Python 3.10+
- Node.js 20.19+ (or 22.12+)
- PostgreSQL

## Local setup

Copy `.env.example` to `.env` and update its PostgreSQL credentials as needed:

```powershell
Copy-Item .env.example .env
```

For the example database values, create a local role and database:

```powershell
psql -U postgres -c "CREATE USER market WITH PASSWORD 'change-me';"
createdb -U postgres -O market marketplace
```

Start the API in one terminal:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m uvicorn backend.app.main:app --reload
```

Start the frontend in a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL (usually http://localhost:5173). Interactive API documentation is at http://localhost:8000/docs. The API creates its tables on startup. It reads `DATABASE_URL`, `CORS_ORIGINS`, and `COOKIE_SECURE` from `.env`; Vite reads `VITE_API_URL`. For local HTTP development, use `COOKIE_SECURE=false`; use HTTPS and `COOKIE_SECURE=true` when deployed.

## Roles

- **Customer** — select the customer account type at registration to browse, search, add products to a bag, place orders, and track them.
- **Vendor** — select vendor at registration to manage a product catalog, see orders containing their products, update only their own items' fulfillment state, and view gross sales, the 10% marketplace fee, and estimated payout.
- **Admin** — registration intentionally cannot create administrator accounts. Promote an existing account through a trusted database session, for example:

  ```sql
  UPDATE users SET role = 'admin' WHERE username = 'your-admin-username';
  ```

  Admins can view order and sales summaries, update order status, and assign customer/vendor/admin roles to other accounts. An admin cannot demote their own account, and the final administrator cannot be demoted.

## API overview

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/register`, `/auth/login` | Public | Create a customer/vendor account or sign in |
| `GET` | `/auth/me` | Signed in | Restore the session and CSRF token |
| `POST` | `/auth/logout` | Signed in | Revoke the current session |
| `GET` | `/products`, `/products/categories` | Public | Browse and filter active products |
| `GET`, `POST` | `/vendor/products` | Vendor | List and create the vendor's products |
| `PATCH`, `DELETE` | `/vendor/products/{id}` | Owning vendor | Update or archive a product |
| `GET` | `/cart` | Customer | Read the shopping bag |
| `POST`, `PATCH`, `DELETE` | `/cart/items/{product_id}` | Customer | Add, change quantity, or remove a bag item |
| `POST`, `GET` | `/orders` | Customer | Place a demo order or view order history |
| `GET` | `/vendor/orders`, `/vendor/analytics` | Vendor | Review fulfillment and payout analytics |
| `PATCH` | `/vendor/orders/{id}/status` | Vendor | Mark an order shipped or delivered |
| `GET` | `/admin/summary`, `/admin/orders`, `/admin/users` | Admin | Review marketplace operations |
| `PATCH` | `/admin/orders/{id}/status`, `/admin/users/{id}/role` | Admin | Manage order status and account roles |

Prices are integer cents in the API. Checkout validates inventory and records orders, but **does not collect payment**. Administrators can cancel orders and restore reserved inventory; estimated vendor payout is gross sales less a 10% platform fee, and this starter does not execute transfers.

Passwords are hashed with Argon2. Authentication uses random server-side session tokens in HttpOnly, SameSite cookies; state-changing requests require the session's CSRF token in `X-CSRF-Token`. Role checks are enforced by the API, not only the interface.

This is a learning starter, not a production-ready commerce system. Before public deployment, add payment provider integration, database migrations, login rate limiting, account recovery, audit logging, stronger operational monitoring, and managed secrets. Use a migration tool such as Alembic when evolving a deployed schema.
