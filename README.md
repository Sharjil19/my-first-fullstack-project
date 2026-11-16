# Todo List

A small full-stack CRUD app with a FastAPI API, React/TypeScript frontend, and PostgreSQL database.

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

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/todos` | List todos |
| `GET` | `/todos/{id}` | Get a todo |
| `POST` | `/todos` | Create a todo (`{"title": "..."}`) |
| `PATCH` | `/todos/{id}` | Update title and/or completion status |
| `DELETE` | `/todos/{id}` | Delete a todo |
