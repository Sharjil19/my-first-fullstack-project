import hashlib
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pwdlib import PasswordHash
from sqlalchemy import Boolean, ForeignKey, Integer, String, create_engine, delete, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://todo:todo@localhost:5432/todos",
)
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in {"1", "true", "yes"}
SESSION_COOKIE = "todo_session"
SESSION_DURATION = 7 * 24 * 60 * 60
password_hasher = PasswordHash.recommended()

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)


class Todo(Base):
    __tablename__ = "todos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return clean_username(value)


class UsernameUpdate(BaseModel):
    username: str = Field(min_length=3, max_length=32)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return clean_username(value)


class PasswordUpdate(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class AccountDelete(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    confirmation: Literal["DELETE"]


class TodoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be blank")
        return value


class TodoUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    completed: bool | None = None

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be blank")
        return value


class TodoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    completed: bool


class AuthRead(BaseModel):
    username: str
    csrf_token: str


class UserRead(BaseModel):
    id: int
    username: str


def clean_username(value: str) -> str:
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", value):
        raise ValueError("Use 3-32 letters, numbers, dots, underscores, or hyphens")
    return value


def migrate_todo_owner_column() -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("todos")}
    if "owner_id" not in columns:
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE todos ADD COLUMN owner_id INTEGER REFERENCES users(id)")
            )


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    migrate_todo_owner_column()
    yield


app = FastAPI(title="Todo API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


DbSession = Annotated[Session, Depends(get_db)]


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def start_session(db: Session, user: User, response: Response) -> AuthRead:
    token = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=token_digest(token),
            csrf_token=csrf_token,
            expires_at=int(time.time()) + SESSION_DURATION,
        )
    )
    db.commit()
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_DURATION,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    return AuthRead(username=user.username, csrf_token=csrf_token)


def get_current_session(
    request: Request,
    db: DbSession,
) -> AuthSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    session = db.scalar(
        select(AuthSession).where(
            AuthSession.token_hash == token_digest(token),
            AuthSession.expires_at > int(time.time()),
        )
    )
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return session


CurrentSession = Annotated[AuthSession, Depends(get_current_session)]


def require_csrf(
    current: CurrentSession,
    csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
) -> AuthSession:
    if not csrf_token or not secrets.compare_digest(current.csrf_token, csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")
    return current


CsrfSession = Annotated[AuthSession, Depends(require_csrf)]


def find_todo(db: Session, todo_id: int, owner_id: int) -> Todo:
    todo = db.scalar(
        select(Todo).where(Todo.id == todo_id, Todo.owner_id == owner_id)
    )
    if todo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Todo not found")
    return todo


@app.post("/auth/register", response_model=AuthRead, status_code=status.HTTP_201_CREATED)
def register(credentials: Credentials, response: Response, db: DbSession):
    user = User(
        username=credentials.username,
        password_hash=password_hasher.hash(credentials.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is unavailable")
    db.refresh(user)
    return start_session(db, user, response)


@app.post("/auth/login", response_model=AuthRead)
def login(credentials: Credentials, response: Response, db: DbSession):
    user = db.scalar(select(User).where(User.username == credentials.username))
    if user is None or not password_hasher.verify(credentials.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    return start_session(db, user, response)


@app.get("/auth/me", response_model=AuthRead)
def get_me(current: CurrentSession, db: DbSession):
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return AuthRead(username=user.username, csrf_token=current.csrf_token)


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(current: CsrfSession, db: DbSession, response: Response):
    db.delete(current)
    db.commit()
    response.delete_cookie(
        key=SESSION_COOKIE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@app.get("/users/me", response_model=UserRead)
def get_profile(current: CurrentSession, db: DbSession):
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return UserRead(id=user.id, username=user.username)


@app.patch("/users/me", response_model=UserRead)
def update_profile(changes: UsernameUpdate, current: CsrfSession, db: DbSession):
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user.username = changes.username
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is unavailable")
    db.refresh(user)
    return UserRead(id=user.id, username=user.username)


@app.post("/users/me/password", response_model=AuthRead)
def change_password(changes: PasswordUpdate, current: CsrfSession, response: Response, db: DbSession):
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    if not password_hasher.verify(changes.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    user.password_hash = password_hasher.hash(changes.new_password)
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()
    return start_session(db, user, response)


@app.delete("/users/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    confirmation: AccountDelete,
    current: CsrfSession,
    response: Response,
    db: DbSession,
):
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    if not password_hasher.verify(confirmation.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is incorrect")
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.execute(delete(Todo).where(Todo.owner_id == user.id))
    db.delete(user)
    db.commit()
    response.delete_cookie(
        key=SESSION_COOKIE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@app.get("/todos", response_model=list[TodoRead])
def list_todos(current: CurrentSession, db: DbSession):
    return db.scalars(
        select(Todo).where(Todo.owner_id == current.user_id).order_by(Todo.id)
    ).all()


@app.post("/todos", response_model=TodoRead, status_code=status.HTTP_201_CREATED)
def create_todo(todo: TodoCreate, current: CsrfSession, db: DbSession):
    new_todo = Todo(title=todo.title, owner_id=current.user_id)
    db.add(new_todo)
    db.commit()
    db.refresh(new_todo)
    return new_todo


@app.get("/todos/{todo_id}", response_model=TodoRead)
def get_todo(todo_id: int, current: CurrentSession, db: DbSession):
    return find_todo(db, todo_id, current.user_id)


@app.patch("/todos/{todo_id}", response_model=TodoRead)
def update_todo(todo_id: int, changes: TodoUpdate, current: CsrfSession, db: DbSession):
    todo = find_todo(db, todo_id, current.user_id)
    for field, value in changes.model_dump(exclude_unset=True).items():
        setattr(todo, field, value)
    db.commit()
    db.refresh(todo)
    return todo


@app.delete("/todos/{todo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_todo(todo_id: int, current: CsrfSession, db: DbSession):
    todo = find_todo(db, todo_id, current.user_id)
    db.delete(todo)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
