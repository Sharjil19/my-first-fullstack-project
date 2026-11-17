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
from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint, create_engine, delete, func, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://market:change-me@localhost:5432/marketplace")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in {"1", "true", "yes"}
SESSION_COOKIE = "market_session"
SESSION_DURATION = 7 * 24 * 60 * 60
COMMISSION_RATE = 0.10
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
    role: Mapped[str] = mapped_column(String(16), default="customer", nullable=False)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), default="", nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    image_url: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    stock: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CartItem(Base):
    __tablename__ = "cart_items"
    __table_args__ = (UniqueConstraint("user_id", "product_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    shipping_address: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="processing", nullable=False)
    total_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), nullable=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    product_name: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="processing", nullable=False)


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=12, max_length=128)
    role: Literal["customer", "vendor"] = "customer"

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return clean_username(value)


class ProductInput(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    category: str = Field(min_length=2, max_length=40)
    price_cents: int = Field(gt=0, le=100_000_000)
    image_url: str = Field(default="", max_length=500)
    stock: int = Field(ge=0, le=1_000_000)

    @field_validator("name", "category")
    @classmethod
    def require_trimmed_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank")
        return value

    @field_validator("description")
    @classmethod
    def trim_description(cls, value: str) -> str:
        return value.strip()


class ProductChanges(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    category: str | None = Field(default=None, min_length=2, max_length=40)
    price_cents: int | None = Field(default=None, gt=0, le=100_000_000)
    image_url: str | None = Field(default=None, max_length=500)
    stock: int | None = Field(default=None, ge=0, le=1_000_000)
    active: bool | None = None

    @field_validator("name", "category")
    @classmethod
    def require_trimmed_text(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank")
        return value


class QuantityChange(BaseModel):
    quantity: int = Field(ge=1, le=99)


class CheckoutInput(BaseModel):
    shipping_address: str = Field(min_length=8, max_length=500)

    @field_validator("shipping_address")
    @classmethod
    def trim_address(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 8:
            raise ValueError("Enter a complete shipping address")
        return value


class StatusChange(BaseModel):
    status: Literal["processing", "shipped", "delivered", "cancelled"]


class RoleChange(BaseModel):
    role: Literal["customer", "vendor", "admin"]


class AuthRead(BaseModel):
    username: str
    role: str
    csrf_token: str


class UserRead(BaseModel):
    id: int
    username: str
    role: str


class ProductRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    vendor_id: int
    vendor_name: str
    name: str
    description: str
    category: str
    price_cents: int
    image_url: str
    stock: int
    active: bool


class CartLineRead(BaseModel):
    product: ProductRead
    quantity: int
    line_total_cents: int


class CartRead(BaseModel):
    items: list[CartLineRead]
    total_cents: int


class OrderItemRead(BaseModel):
    product_name: str
    quantity: int
    unit_price_cents: int
    vendor_name: str
    status: str


class OrderRead(BaseModel):
    id: int
    customer_name: str
    shipping_address: str
    status: str
    total_cents: int
    created_at: int
    items: list[OrderItemRead]


class PayoutRead(BaseModel):
    gross_sales_cents: int
    platform_fee_cents: int
    estimated_payout_cents: int
    order_count: int
    units_sold: int


def clean_username(value: str) -> str:
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", value):
        raise ValueError("Use 3-32 letters, numbers, dots, underscores, or hyphens")
    return value


def migrate_user_role() -> None:
    if "users" in inspect(engine).get_table_names():
        columns = {column["name"] for column in inspect(engine).get_columns("users")}
        if "role" not in columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'customer'"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    migrate_user_role()
    yield


app = FastAPI(title="Shoplix API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if origin.strip()],
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
    db.add(AuthSession(user_id=user.id, token_hash=token_digest(token), csrf_token=csrf_token, expires_at=int(time.time()) + SESSION_DURATION))
    db.commit()
    response.set_cookie(key=SESSION_COOKIE, value=token, max_age=SESSION_DURATION, httponly=True, secure=COOKIE_SECURE, samesite="strict", path="/")
    return AuthRead(username=user.username, role=user.role, csrf_token=csrf_token)


def get_current_session(request: Request, db: DbSession) -> AuthSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    current = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_digest(token), AuthSession.expires_at > int(time.time())))
    if current is None or db.get(User, current.user_id) is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return current


CurrentSession = Annotated[AuthSession, Depends(get_current_session)]


def require_csrf(current: CurrentSession, csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None) -> AuthSession:
    if not csrf_token or not secrets.compare_digest(current.csrf_token, csrf_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
    return current


CsrfSession = Annotated[AuthSession, Depends(require_csrf)]


def user_for_session(db: Session, current: AuthSession) -> User:
    user = db.get(User, current.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_role(db: Session, current: AuthSession, *roles: str) -> User:
    user = user_for_session(db, current)
    if user.role not in roles:
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action")
    return user


def product_read(db: Session, product: Product) -> dict:
    vendor = db.get(User, product.vendor_id)
    return {**{field: getattr(product, field) for field in ("id", "vendor_id", "name", "description", "category", "price_cents", "image_url", "stock", "active")}, "vendor_name": vendor.username if vendor else "Marketplace vendor"}


def order_read(db: Session, order: Order) -> dict:
    customer = db.get(User, order.customer_id)
    items = db.scalars(select(OrderItem).where(OrderItem.order_id == order.id).order_by(OrderItem.id)).all()
    return {
        "id": order.id,
        "customer_name": customer.username if customer else "Customer",
        "shipping_address": order.shipping_address,
        "status": order.status,
        "total_cents": order.total_cents,
        "created_at": order.created_at,
        "items": [
            {"product_name": item.product_name, "quantity": item.quantity, "unit_price_cents": item.unit_price_cents, "vendor_name": (db.get(User, item.vendor_id).username if db.get(User, item.vendor_id) else "Vendor"), "status": item.status}
            for item in items
        ],
    }


def owned_product(db: Session, product_id: int, vendor_id: int) -> Product:
    product = db.scalar(select(Product).where(Product.id == product_id, Product.vendor_id == vendor_id))
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/auth/register", response_model=AuthRead, status_code=201)
def register(credentials: Credentials, response: Response, db: DbSession):
    user = User(username=credentials.username, password_hash=password_hasher.hash(credentials.password), role=credentials.role)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Username is unavailable")
    db.refresh(user)
    return start_session(db, user, response)


@app.post("/auth/login", response_model=AuthRead)
def login(credentials: Credentials, response: Response, db: DbSession):
    user = db.scalar(select(User).where(User.username == credentials.username))
    if user is None or not password_hasher.verify(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    return start_session(db, user, response)


@app.get("/auth/me", response_model=AuthRead)
def get_me(current: CurrentSession, db: DbSession):
    user = user_for_session(db, current)
    return AuthRead(username=user.username, role=user.role, csrf_token=current.csrf_token)


@app.post("/auth/logout", status_code=204)
def logout(current: CsrfSession, db: DbSession, response: Response):
    db.delete(current)
    db.commit()
    response.delete_cookie(key=SESSION_COOKIE, httponly=True, secure=COOKIE_SECURE, samesite="strict", path="/")
    return Response(status_code=204)


@app.get("/products", response_model=list[ProductRead])
def list_products(db: DbSession, search: str = "", category: str = ""):
    query = select(Product).where(Product.active.is_(True), Product.stock > 0)
    if search.strip():
        term = f"%{search.strip()}%"
        query = query.where(Product.name.ilike(term) | Product.description.ilike(term))
    if category.strip() and category != "All":
        query = query.where(Product.category == category)
    products = db.scalars(query.order_by(Product.id.desc())).all()
    return [product_read(db, product) for product in products]


@app.get("/products/categories", response_model=list[str])
def product_categories(db: DbSession):
    return db.scalars(select(Product.category).where(Product.active.is_(True)).distinct().order_by(Product.category)).all()


@app.get("/vendor/products", response_model=list[ProductRead])
def vendor_products(current: CurrentSession, db: DbSession):
    vendor = require_role(db, current, "vendor", "admin")
    return [product_read(db, product) for product in db.scalars(select(Product).where(Product.vendor_id == vendor.id).order_by(Product.id.desc())).all()]


@app.post("/vendor/products", response_model=ProductRead, status_code=201)
def create_product(data: ProductInput, current: CsrfSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    product = Product(vendor_id=vendor.id, **data.model_dump())
    db.add(product)
    db.commit()
    db.refresh(product)
    return product_read(db, product)


@app.patch("/vendor/products/{product_id}", response_model=ProductRead)
def update_product(product_id: int, changes: ProductChanges, current: CsrfSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    product = owned_product(db, product_id, vendor.id)
    for field, value in changes.model_dump(exclude_unset=True).items():
        setattr(product, field, value.strip() if isinstance(value, str) else value)
    db.commit()
    db.refresh(product)
    return product_read(db, product)


@app.delete("/vendor/products/{product_id}", status_code=204)
def delete_product(product_id: int, current: CsrfSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    product = owned_product(db, product_id, vendor.id)
    product.active = False
    db.commit()
    return Response(status_code=204)


def cart_response(db: Session, user_id: int) -> dict:
    cart_items = db.scalars(select(CartItem).where(CartItem.user_id == user_id).order_by(CartItem.id)).all()
    items = []
    for cart_item in cart_items:
        product = db.get(Product, cart_item.product_id)
        if product:
            items.append({"product": product_read(db, product), "quantity": cart_item.quantity, "line_total_cents": product.price_cents * cart_item.quantity})
    return {"items": items, "total_cents": sum(item["line_total_cents"] for item in items)}


@app.get("/cart", response_model=CartRead)
def get_cart(current: CurrentSession, db: DbSession):
    user = require_role(db, current, "customer")
    return cart_response(db, user.id)


@app.post("/cart/items/{product_id}", response_model=CartRead)
def add_to_cart(product_id: int, quantity: QuantityChange, current: CsrfSession, db: DbSession):
    user = require_role(db, current, "customer")
    product = db.scalar(select(Product).where(Product.id == product_id, Product.active.is_(True)))
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    existing = db.scalar(select(CartItem).where(CartItem.user_id == user.id, CartItem.product_id == product.id))
    total_quantity = quantity.quantity + (existing.quantity if existing else 0)
    if total_quantity > product.stock:
        raise HTTPException(status_code=400, detail="Not enough stock available")
    if existing:
        existing.quantity = total_quantity
    else:
        db.add(CartItem(user_id=user.id, product_id=product.id, quantity=quantity.quantity))
    db.commit()
    return cart_response(db, user.id)


@app.patch("/cart/items/{product_id}", response_model=CartRead)
def update_cart_item(product_id: int, quantity: QuantityChange, current: CsrfSession, db: DbSession):
    user = require_role(db, current, "customer")
    item = db.scalar(select(CartItem).where(CartItem.user_id == user.id, CartItem.product_id == product_id))
    product = db.get(Product, product_id)
    if item is None or product is None or not product.active:
        raise HTTPException(status_code=404, detail="Cart item not found")
    if quantity.quantity > product.stock:
        raise HTTPException(status_code=400, detail="Not enough stock available")
    item.quantity = quantity.quantity
    db.commit()
    return cart_response(db, user.id)


@app.delete("/cart/items/{product_id}", response_model=CartRead)
def remove_cart_item(product_id: int, current: CsrfSession, db: DbSession):
    user = require_role(db, current, "customer")
    db.execute(delete(CartItem).where(CartItem.user_id == user.id, CartItem.product_id == product_id))
    db.commit()
    return cart_response(db, user.id)


@app.post("/orders", response_model=OrderRead, status_code=201)
def checkout(data: CheckoutInput, current: CsrfSession, db: DbSession):
    customer = require_role(db, current, "customer")
    cart_items = db.scalars(select(CartItem).where(CartItem.user_id == customer.id).with_for_update()).all()
    if not cart_items:
        raise HTTPException(status_code=400, detail="Your cart is empty")
    products = {}
    total = 0
    for item in cart_items:
        product = db.scalar(select(Product).where(Product.id == item.product_id).with_for_update())
        if product is None or not product.active or product.stock < item.quantity:
            raise HTTPException(status_code=409, detail="A cart item is unavailable or has insufficient stock")
        products[item.product_id] = product
        total += product.price_cents * item.quantity
    order = Order(customer_id=customer.id, shipping_address=data.shipping_address, total_cents=total, created_at=int(time.time()))
    db.add(order)
    db.flush()
    for item in cart_items:
        product = products[item.product_id]
        product.stock -= item.quantity
        db.add(OrderItem(order_id=order.id, product_id=product.id, vendor_id=product.vendor_id, product_name=product.name, quantity=item.quantity, unit_price_cents=product.price_cents))
        db.delete(item)
    db.commit()
    db.refresh(order)
    return order_read(db, order)


def user_orders(db: Session, statement) -> list[dict]:
    return [order_read(db, order) for order in db.scalars(statement.order_by(Order.created_at.desc())).all()]


@app.get("/orders", response_model=list[OrderRead])
def list_orders(current: CurrentSession, db: DbSession):
    customer = require_role(db, current, "customer")
    return user_orders(db, select(Order).where(Order.customer_id == customer.id))


@app.get("/vendor/orders", response_model=list[OrderRead])
def list_vendor_orders(current: CurrentSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    order_ids = select(OrderItem.order_id).where(OrderItem.vendor_id == vendor.id).distinct()
    return user_orders(db, select(Order).where(Order.id.in_(order_ids)))


@app.patch("/vendor/orders/{order_id}/status", response_model=OrderRead)
def update_vendor_order(order_id: int, changes: StatusChange, current: CsrfSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    order = db.scalar(select(Order).where(Order.id == order_id))
    vendor_items = db.scalars(select(OrderItem).where(OrderItem.order_id == order_id, OrderItem.vendor_id == vendor.id)).all()
    if order is None or not vendor_items:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.status == "cancelled":
        raise HTTPException(status_code=400, detail="Cancelled orders cannot be fulfilled")
    if changes.status not in {"shipped", "delivered"}:
        raise HTTPException(status_code=400, detail="Vendors can mark orders shipped or delivered")
    for item in vendor_items:
        item.status = changes.status
    db.flush()
    all_statuses = db.scalars(select(OrderItem.status).where(OrderItem.order_id == order_id)).all()
    order.status = "delivered" if all(item_status == "delivered" for item_status in all_statuses) else "shipped" if any(item_status in {"shipped", "delivered"} for item_status in all_statuses) else "processing"
    db.commit()
    return order_read(db, order)


@app.get("/vendor/analytics", response_model=PayoutRead)
def vendor_analytics(current: CurrentSession, db: DbSession):
    vendor = require_role(db, current, "vendor")
    gross, orders, units = db.execute(
        select(func.coalesce(func.sum(OrderItem.unit_price_cents * OrderItem.quantity), 0), func.count(func.distinct(OrderItem.order_id)), func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(OrderItem.vendor_id == vendor.id, Order.status != "cancelled")
    ).one()
    gross = int(gross)
    fee = round(gross * COMMISSION_RATE)
    return PayoutRead(gross_sales_cents=gross, platform_fee_cents=fee, estimated_payout_cents=gross - fee, order_count=int(orders), units_sold=int(units))


@app.get("/admin/summary")
def admin_summary(current: CurrentSession, db: DbSession):
    require_role(db, current, "admin")
    gross = int(db.scalar(select(func.coalesce(func.sum(Order.total_cents), 0)).where(Order.status != "cancelled")) or 0)
    return {
        "customers": int(db.scalar(select(func.count(User.id)).where(User.role == "customer")) or 0),
        "vendors": int(db.scalar(select(func.count(User.id)).where(User.role == "vendor")) or 0),
        "products": int(db.scalar(select(func.count(Product.id)).where(Product.active.is_(True))) or 0),
        "orders": int(db.scalar(select(func.count(Order.id))) or 0),
        "gross_sales_cents": gross,
        "estimated_vendor_payouts_cents": round(gross * (1 - COMMISSION_RATE)),
    }


@app.get("/admin/orders", response_model=list[OrderRead])
def admin_orders(current: CurrentSession, db: DbSession):
    require_role(db, current, "admin")
    return user_orders(db, select(Order))


@app.patch("/admin/orders/{order_id}/status", response_model=OrderRead)
def admin_update_order(order_id: int, changes: StatusChange, current: CsrfSession, db: DbSession):
    require_role(db, current, "admin")
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    items = db.scalars(select(OrderItem).where(OrderItem.order_id == order_id)).all()
    if changes.status == "cancelled" and order.status != "cancelled":
        for item in items:
            product = db.get(Product, item.product_id) if item.product_id is not None else None
            if product:
                product.stock += item.quantity
    elif order.status == "cancelled" and changes.status != "cancelled":
        for item in items:
            product = db.scalar(select(Product).where(Product.id == item.product_id).with_for_update()) if item.product_id is not None else None
            if product is None or product.stock < item.quantity:
                raise HTTPException(status_code=409, detail="A cancelled order cannot be reopened because inventory is unavailable")
        for item in items:
            product = db.get(Product, item.product_id) if item.product_id is not None else None
            if product:
                product.stock -= item.quantity
    order.status = changes.status
    for item in items:
        item.status = changes.status
    db.commit()
    return order_read(db, order)


@app.get("/admin/users", response_model=list[UserRead])
def admin_users(current: CurrentSession, db: DbSession):
    require_role(db, current, "admin")
    return db.scalars(select(User).order_by(User.id)).all()


@app.patch("/admin/users/{user_id}/role", response_model=UserRead)
def admin_update_role(user_id: int, changes: RoleChange, current: CsrfSession, db: DbSession):
    admin = require_role(db, current, "admin")
    if admin.id == user_id:
        raise HTTPException(status_code=400, detail="You cannot change your own administrator role")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "vendor" and changes.role != "vendor":
        for product in db.scalars(select(Product).where(Product.vendor_id == user.id)).all():
            product.active = False
    if user.role == "admin" and changes.role != "admin":
        admin_count = db.scalar(select(func.count(User.id)).where(User.role == "admin")) or 0
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="At least one administrator must remain")
    user.role = changes.role
    db.commit()
    db.refresh(user)
    return user
