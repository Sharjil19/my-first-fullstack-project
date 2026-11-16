# Todo List

A small full-stack CRUD app with a FastAPI API, React/TypeScript frontend, and PostgreSQL database.
Users can sign up and sign in; todos are private to the account that created them.

## Requirements

- Python 3.10+
- Node.js 20.19+ (or 22.12+)
- PostgreSQL installed and running locally

## Setup

From the project root, copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Create a PostgreSQL role and database matching the values in `.env` (or update `DATABASE_URL` to match your existing local database):

```powershell
psql -U postgres -c "CREATE USER todo WITH PASSWORD 'change-me';"
createdb -U postgres -O todo todos
```

In a first terminal, create a Python environment, install backend dependencies, and start the API:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m uvicorn backend.app.main:app --reload
```

In a second terminal, install frontend dependencies and start the React app:

```powershell
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (usually http://localhost:5173). The API documentation is available at http://localhost:8000/docs.

The backend creates the `todos` table automatically on startup. The frontend reads `VITE_API_URL`; the backend reads `DATABASE_URL` and `CORS_ORIGINS` from the root `.env` file.
For local HTTP development, keep `COOKIE_SECURE=false`. Set `COOKIE_SECURE=true` when serving the API over HTTPS.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/register` | Create an account and sign in |
| `POST` | `/auth/login` | Sign in |
| `GET` | `/auth/me` | Get the signed-in account and CSRF token |
| `POST` | `/auth/logout` | Sign out |
| `GET` | `/todos` | List your todos |
| `GET` | `/todos/{id}` | Get one of your todos |
| `POST` | `/todos` | Create a todo (`{"title": "..."}`) |
| `PATCH` | `/todos/{id}` | Update your todo's title and/or completion status |
| `DELETE` | `/todos/{id}` | Delete your todo |

Passwords must be 12-128 characters. They are stored as Argon2 hashes. Sessions use random, server-side tokens in HttpOnly, SameSite cookies; write requests also require a CSRF token. Use HTTPS and set `COOKIE_SECURE=true` outside local development. If you already have todos from an earlier version, they are left unassigned and are not exposed to any account.

This is a learning app, not a production-ready identity service. Before exposing it publicly, add login rate limiting and account recovery, and use managed secrets and database migrations.
