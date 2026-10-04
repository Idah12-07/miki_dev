//! `orders` table plus the order detail view used by the API.

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::{MySql, MySqlPool};
use uuid::Uuid;

use crate::error::ApiError;

use super::{invoice, payment, transaction, user};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Order {
    pub id: i64,
    pub order_number: String,
    pub user_id: i64,
    pub amount: i64,
    pub currency: String,
    pub description: Option<String>,
    pub status: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// Validated input for [`create`].
#[derive(Debug, Clone)]
pub struct NewOrder {
    pub email: String,
    pub name: Option<String>,
    pub amount: i64,
    pub currency: String,
    pub description: Option<String>,
}

/// Everything the API returns for a single order.
#[derive(Debug, Serialize)]
pub struct OrderDetail {
    pub order: Order,
    pub user: user::User,
    pub invoices: Vec<invoice::Invoice>,
    pub payments: Vec<payment::Payment>,
    pub transactions: Vec<transaction::Transaction>,
}

fn new_order_number() -> String {
    format!("ORD-{}", Uuid::new_v4().simple())
}

/// Create an order, upserting its user, inside a single transaction so an
/// order can never exist without its user.
pub async fn create(pool: &MySqlPool, input: NewOrder) -> Result<Order, ApiError> {
    let mut tx = pool.begin().await?;

    let user = user::find_or_create(&mut tx, &input.email, input.name.as_deref()).await?;

    let result = sqlx::query(
        "INSERT INTO orders (order_number, user_id, amount, currency, description)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(new_order_number())
    .bind(user.id)
    .bind(input.amount)
    .bind(&input.currency)
    .bind(&input.description)
    .execute(&mut *tx)
    .await?;

    let id = result.last_insert_id() as i64;

    let order = find_by_id(&mut *tx, id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("order {id} vanished after insert")))?;

    tx.commit().await?;

    Ok(order)
}

pub async fn find_by_id<'e, E>(executor: E, id: i64) -> Result<Option<Order>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, Order>("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(executor)
        .await
}

/// Lock an order row for the duration of the caller's transaction.
///
/// Serializes invoice creation per order: the check for an existing
/// invoice and the placeholder insert happen atomically. Must only be
/// used inside a short, database-only transaction — never held across
/// network calls.
pub async fn lock_by_id(
    tx: &mut sqlx::Transaction<'_, MySql>,
    id: i64,
) -> Result<Option<Order>, sqlx::Error> {
    sqlx::query_as::<_, Order>("SELECT * FROM orders WHERE id = ? FOR UPDATE")
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await
}

/// Fetch an order together with its user and all related records.
pub async fn find_detail(pool: &MySqlPool, id: i64) -> Result<OrderDetail, ApiError> {
    let order = find_by_id(pool, id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("order {id} not found")))?;

    let user = user::find_by_id(pool, order.user_id)
        .await?
        .ok_or_else(|| {
            ApiError::Internal(format!(
                "order {id} references missing user {}",
                order.user_id
            ))
        })?;

    let invoices = invoice::list_by_order(pool, id).await?;
    let payments = payment::list_by_order(pool, id).await?;
    let transactions = transaction::list_by_order(pool, id).await?;

    Ok(OrderDetail {
        order,
        user,
        invoices,
        payments,
        transactions,
    })
}

/// Settle an order: `paid` unless it was explicitly cancelled.
///
/// `expired` is included deliberately — a payment that arrives after the
/// order was expired still has to be recorded as paid. Only `cancelled`
/// is sticky, and the guard makes the statement idempotent: a replayed
/// webhook reports `rows_affected = 0` when the order is already paid.
pub async fn mark_paid(
    tx: &mut sqlx::Transaction<'_, MySql>,
    order_id: i64,
    now: NaiveDateTime,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE orders
         SET status = 'paid', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'processing', 'expired')",
    )
    .bind(now)
    .bind(order_id)
    .execute(tx.as_mut())
    .await?;

    Ok(result.rows_affected() == 1)
}

/// Expire an order when none of its other invoices can still be paid.
///
/// An order may hold several invoices over its lifetime (one per attempt
///); expiring it because *one* of them lapsed while another is still
/// active would lock a paying customer out. The `NOT EXISTS` clause
/// skips that case, and `status IN (...)` keeps the update idempotent
/// and prevents a cancelled or already paid order from being expired.
pub async fn mark_expired(
    tx: &mut sqlx::Transaction<'_, MySql>,
    order_id: i64,
    lapsed_invoice_id: i64,
    now: NaiveDateTime,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE orders
         SET status = 'expired', updated_at = ?
         WHERE id = ?
           AND status IN ('pending', 'processing')
           AND NOT EXISTS (
               SELECT 1 FROM invoices i
               WHERE i.order_id = ?
                 AND i.id <> ?
                 AND i.status IN ('pending', 'processing')
           )",
    )
    .bind(now)
    .bind(order_id)
    .bind(order_id)
    .bind(lapsed_invoice_id)
    .execute(tx.as_mut())
    .await?;

    Ok(result.rows_affected() == 1)
}
