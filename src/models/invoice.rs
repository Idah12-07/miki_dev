//! `invoices` table.
//!
//! BTCPay integration writes `btcpay_invoice_id`, `payment_url` and
//! `expires_at` when an invoice is created. `paid_at` and `status =
//! 'paid'` are reserved for the webhook phase: creating an invoice never
//! marks it paid.

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::MySql;

#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Invoice {
    pub id: i64,
    pub order_id: i64,
    pub invoice_number: String,
    pub amount: i64,
    pub currency: String,
    pub status: String,
    pub btcpay_invoice_id: Option<String>,
    pub payment_url: Option<String>,
    pub expires_at: Option<NaiveDateTime>,
    pub paid_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

pub async fn list_by_order<'e, E>(executor: E, order_id: i64) -> Result<Vec<Invoice>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, Invoice>("SELECT * FROM invoices WHERE order_id = ? ORDER BY id ASC")
        .bind(order_id)
        .fetch_all(executor)
        .await
}

/// Most recent invoice row for an order, including in-flight placeholders
/// (`btcpay_invoice_id IS NULL`).
pub async fn find_latest_by_order<'e, E>(
    executor: E,
    order_id: i64,
) -> Result<Option<Invoice>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, Invoice>(
        "SELECT * FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(order_id)
    .fetch_optional(executor)
    .await
}

/// Insert an unpaid placeholder row *before* calling BTCPay. The row is
/// the duplicate-invoice reservation token: any concurrent request sees
/// it and reuses/backs off instead of creating a second invoice. Amount
/// and currency are copied from the order — never from the client.
///
/// `created_at`/`updated_at` are written explicitly in UTC (Rust clock)
/// so placeholder-age comparisons in the service layer never depend on
/// the database session timezone.
pub async fn insert_placeholder(
    tx: &mut sqlx::Transaction<'_, MySql>,
    order_id: i64,
    invoice_number: &str,
    amount: i64,
    currency: &str,
    now: chrono::NaiveDateTime,
) -> Result<i64, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO invoices
             (order_id, invoice_number, amount, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(order_id)
    .bind(invoice_number)
    .bind(amount)
    .bind(currency)
    .bind(now)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    Ok(result.last_insert_id() as i64)
}

/// Atomically claim a placeholder for a BTCPay invoice. The
/// `AND btcpay_invoice_id IS NULL` guard makes the claim one-shot: only
/// the first writer can fill the BTCPay fields.
pub async fn claim_btcpay(
    tx: &mut sqlx::Transaction<'_, MySql>,
    invoice_id: i64,
    btcpay_invoice_id: &str,
    payment_url: &str,
    expires_at: Option<chrono::NaiveDateTime>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE invoices
         SET btcpay_invoice_id = ?, payment_url = ?, expires_at = ?
         WHERE id = ? AND btcpay_invoice_id IS NULL",
    )
    .bind(btcpay_invoice_id)
    .bind(payment_url)
    .bind(expires_at)
    .bind(invoice_id)
    .execute(tx.as_mut())
    .await?;

    Ok(result.rows_affected() == 1)
}

/// Remove a placeholder that never became a real BTCPay invoice (provider
/// rejected the request, or the process crashed while creating one).
/// Refuses to touch rows that were already claimed.
pub async fn delete_placeholder(
    tx: &mut sqlx::Transaction<'_, MySql>,
    invoice_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM invoices WHERE id = ? AND btcpay_invoice_id IS NULL")
        .bind(invoice_id)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// Lock the invoice that a BTCPay webhook refers to, for the duration of
/// the caller's transaction. `btcpay_invoice_id` is unique, so at most
/// one row matches — and serializing on it is what makes webhook
/// processing idempotent: two deliveries of the same event cannot
/// interleave between "read the current status" and "write the new one".
pub async fn lock_by_btcpay_id(
    tx: &mut sqlx::Transaction<'_, MySql>,
    btcpay_invoice_id: &str,
) -> Result<Option<Invoice>, sqlx::Error> {
    sqlx::query_as::<_, Invoice>("SELECT * FROM invoices WHERE btcpay_invoice_id = ? FOR UPDATE")
        .bind(btcpay_invoice_id)
        .fetch_optional(tx.as_mut())
        .await
}

/// Write a new status (and `paid_at`) for a locked invoice.
///
/// The `WHERE` clause is a second line of defence on top of the caller's
/// status-transition check: a `paid` invoice is never overwritten by a
/// later, non-paying status. `paid_at` is only ever set once —
/// `COALESCE` keeps the first settlement time.
pub async fn set_status(
    tx: &mut sqlx::Transaction<'_, MySql>,
    invoice_id: i64,
    status: &str,
    paid_at: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE invoices
         SET status = ?, paid_at = COALESCE(paid_at, ?), updated_at = ?
         WHERE id = ? AND (status <> 'paid' OR ? = 'paid')",
    )
    .bind(status)
    .bind(paid_at)
    .bind(now)
    .bind(invoice_id)
    .bind(status)
    .execute(tx.as_mut())
    .await?;

    Ok(result.rows_affected() == 1)
}
