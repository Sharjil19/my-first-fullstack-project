import { FormEvent, useCallback, useEffect, useState } from "react";

type Todo = {
  id: number;
  title: string;
  completed: boolean;
};

type Auth = {
  username: string;
  csrf_token: string;
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

async function request<T>(
  path: string,
  init?: RequestInit,
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? body.detail
        : undefined;
    let message = `Request failed (${response.status})`;
    if (typeof detail === "string") {
      message = detail;
    } else if (Array.isArray(detail)) {
      const validationMessages = detail.map((issue: unknown) => {
        if (typeof issue !== "object" || issue === null) return "";
        const entry = issue as { loc?: unknown; msg?: unknown };
        const location = Array.isArray(entry.loc)
          ? entry.loc.filter((part): part is string => typeof part === "string").slice(1).join(".")
          : "";
        const description = typeof entry.msg === "string" ? entry.msg : "Invalid value";
        return location ? `${location}: ${description}` : description;
      }).filter(Boolean);
      if (validationMessages.length > 0) message = validationMessages.join("; ");
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const loadTodos = useCallback(async () => {
    setTodos(await request<Todo[]>("/todos"));
  }, []);

  const restoreSession = useCallback(async () => {
    try {
      const current = await request<Auth>("/auth/me");
      setAuth(current);
      await loadTodos();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Could not connect to the server");
      }
    } finally {
      setLoading(false);
    }
  }, [loadTodos]);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const endpoint = isRegistering ? "/auth/register" : "/auth/login";
      const current = await request<Auth>(endpoint, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setAuth(current);
      setPassword("");
      await loadTodos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not authenticate");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      await request<void>("/auth/logout", { method: "POST" }, auth.csrf_token);
      setAuth(null);
      setTodos([]);
      setUsername("");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  async function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || !auth) return;
    try {
      setError("");
      const todo = await request<Todo>(
        "/todos",
        { method: "POST", body: JSON.stringify({ title }) },
        auth.csrf_token,
      );
      setTodos((current) => [...current, todo]);
      setNewTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add todo");
    }
  }

  async function toggleTodo(todo: Todo) {
    if (!auth) return;
    try {
      setError("");
      const updated = await request<Todo>(
        `/todos/${todo.id}`,
        { method: "PATCH", body: JSON.stringify({ completed: !todo.completed }) },
        auth.csrf_token,
      );
      setTodos((current) => current.map((item) => (item.id === todo.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update todo");
    }
  }

  async function saveTitle(todo: Todo) {
    if (!auth) return;
    const title = editingTitle.trim();
    if (!title) {
      setError("Title cannot be blank");
      return;
    }
    try {
      setError("");
      const updated = await request<Todo>(
        `/todos/${todo.id}`,
        { method: "PATCH", body: JSON.stringify({ title }) },
        auth.csrf_token,
      );
      setTodos((current) => current.map((item) => (item.id === todo.id ? updated : item)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update todo");
    }
  }

  async function deleteTodo(todo: Todo) {
    if (!auth) return;
    try {
      setError("");
      await request<void>(
        `/todos/${todo.id}`,
        { method: "DELETE" },
        auth.csrf_token,
      );
      setTodos((current) => current.filter((item) => item.id !== todo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete todo");
    }
  }

  if (loading) {
    return (
      <main className="page">
        <p className="empty-state">Loading your account...</p>
      </main>
    );
  }

  if (!auth) {
    return (
      <main className="page">
        <section className="todo-card auth-card" aria-labelledby="page-title">
          <header className="heading">
            <div className="eyebrow">YOUR DAY, IN FOCUS</div>
            <h1 id="page-title">{isRegistering ? "Create your account" : "Welcome back"}</h1>
            <p>
              {isRegistering
                ? "Make a private space for your tasks."
                : "Sign in to pick up where you left off."}
            </p>
          </header>

          <form className="auth-form" onSubmit={submitAuth}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={32}
              pattern="^[A-Za-z0-9._-]{3,32}$"
              required
            />
            <p className="field-note">3–32 letters, numbers, dots, underscores, or hyphens.</p>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={isRegistering ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
            <p className="field-note">
              {isRegistering
                ? "Use at least 12 characters. Longer passphrases are a good choice."
                : "Passwords must be 12–128 characters."}
            </p>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? "Please wait..." : isRegistering ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="auth-switch">
            {isRegistering ? "Already have an account?" : "New here?"}{" "}
            <button
              type="button"
              onClick={() => {
                setIsRegistering((current) => !current);
                setError("");
              }}
            >
              {isRegistering ? "Sign in" : "Create an account"}
            </button>
          </p>
        </section>
        <p className="page-note">A little progress is still progress.</p>
      </main>
    );
  }

  const remaining = todos.filter((todo) => !todo.completed).length;

  return (
    <main className="page">
      <section className="todo-card" aria-labelledby="page-title">
        <header className="heading app-heading">
          <div className="eyebrow">YOUR DAY, IN FOCUS</div>
          <div className="welcome-row">
            <div>
              <h1 id="page-title">Things to do</h1>
              <p>Small steps add up. What would you like to get done?</p>
            </div>
            <button className="signout-button" type="button" onClick={() => void signOut()} disabled={busy}>
              Sign out
            </button>
          </div>
          <p className="signed-in-as">Signed in as <strong>{auth.username}</strong></p>
        </header>

        {error && (
          <div className="error" role="alert">
            {error}
            <button type="button" className="dismiss" onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        <form className="add-form" onSubmit={addTodo}>
          <label className="visually-hidden" htmlFor="new-todo">
            Add a task
          </label>
          <input
            id="new-todo"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="Write a task..."
            maxLength={200}
          />
          <button type="submit" disabled={!newTitle.trim()}>
            Add task
          </button>
        </form>

        <div className="list-heading">
          <h2>Tasks</h2>
          <span>{remaining} left</span>
        </div>

        {todos.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">✦</span>
            <p>No tasks yet. Add one above to get started.</p>
          </div>
        ) : (
          <ul className="todo-list">
            {todos.map((todo) => (
              <li className={`todo-item${todo.completed ? " completed" : ""}`} key={todo.id}>
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => void toggleTodo(todo)}
                  aria-label={`Mark "${todo.title}" ${todo.completed ? "incomplete" : "complete"}`}
                />
                {editingId === todo.id ? (
                  <form
                    className="edit-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveTitle(todo);
                    }}
                  >
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      maxLength={200}
                      aria-label="Edit task"
                    />
                    <button className="text-button save-button" type="submit">Save</button>
                    <button className="text-button" type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="todo-title">{todo.title}</span>
                    <div className="todo-actions">
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => {
                          setEditingId(todo.id);
                          setEditingTitle(todo.title);
                        }}
                        aria-label={`Edit "${todo.title}"`}
                        title="Edit task"
                      >
                        ✎
                      </button>
                      <button
                        className="icon-button delete-button"
                        type="button"
                        onClick={() => void deleteTodo(todo)}
                        aria-label={`Delete "${todo.title}"`}
                        title="Delete task"
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {todos.length > 0 && (
          <footer className="list-footer">
            {todos.length - remaining} of {todos.length} completed
          </footer>
        )}
      </section>
      <p className="page-note">A little progress is still progress.</p>
    </main>
  );
}
