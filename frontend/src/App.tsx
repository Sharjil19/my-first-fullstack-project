import { FormEvent, useCallback, useEffect, useState } from "react";

type Todo = {
  id: number;
  title: string;
  completed: boolean;
};

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadTodos = useCallback(async () => {
    try {
      setError("");
      setTodos(await request<Todo[]>("/todos"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load todos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  async function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      setError("");
      const todo = await request<Todo>("/todos", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setTodos((current) => [...current, todo]);
      setNewTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add todo");
    }
  }

  async function toggleTodo(todo: Todo) {
    try {
      setError("");
      const updated = await request<Todo>(`/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: !todo.completed }),
      });
      setTodos((current) => current.map((item) => (item.id === todo.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update todo");
    }
  }

  async function saveTitle(todo: Todo) {
    const title = editingTitle.trim();
    if (!title) {
      setError("Title cannot be blank");
      return;
    }
    try {
      setError("");
      const updated = await request<Todo>(`/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setTodos((current) => current.map((item) => (item.id === todo.id ? updated : item)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update todo");
    }
  }

  async function deleteTodo(todo: Todo) {
    try {
      setError("");
      await request<void>(`/todos/${todo.id}`, { method: "DELETE" });
      setTodos((current) => current.filter((item) => item.id !== todo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete todo");
    }
  }

  const remaining = todos.filter((todo) => !todo.completed).length;

  return (
    <main className="page">
      <section className="todo-card" aria-labelledby="page-title">
        <header className="heading">
          <div className="eyebrow">YOUR DAY, IN FOCUS</div>
          <h1 id="page-title">Things to do</h1>
          <p>Small steps add up. What would you like to get done?</p>
        </header>

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

        {error && (
          <div className="error" role="alert">
            {error}
            <button type="button" className="dismiss" onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        <div className="list-heading">
          <h2>Tasks</h2>
          <span>{remaining} left</span>
        </div>

        {loading ? (
          <p className="empty-state">Loading your tasks...</p>
        ) : todos.length === 0 ? (
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
        {!loading && todos.length > 0 && (
          <footer className="list-footer">
            {todos.length - remaining} of {todos.length} completed
          </footer>
        )}
      </section>
      <p className="page-note">A little progress is still progress.</p>
    </main>
  );
}
