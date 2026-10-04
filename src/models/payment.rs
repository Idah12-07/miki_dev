//! `payments` table.
//!
//! One row per BTCPay invoice: `external_id` carries the BTCPay invoice
//! id and its UNIQUE key is what makes webhook handling idempotent — a
//! redelivered event can never insert a second payment for the same
//! invoice.

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::MySql;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Payment {
    pub id: i64,
    pub invoice_id: i64,
    pub order_id: i64,
    pub method: String,
    pub status: String,
    pub amount: Option<i64>,
    pub currency: Option<String>,
    pub confirmations: i32,
    pub txid: Option<String>,
    pub external_id: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// Validated input for [`insert`].
#[derive(Debug, Clone)]
pub struct NewPayment {
    pub invoice_id: i64,
    pub order_id: i64,
    /// `bitcoin` (on-chain) or `lightning`, when BTCPay told us which
    /// rail the payment arrived on.
    pub method: String,
    pub status: String,
    /// Minor units, copied from the local invoice — never from a
    /// webhook payload.
    pub amount: i64,
    pub currency: String,
    pub confirmations: i32,
    pub txid: Option<String>,
    /// BTCPay invoice id; the UNIQUE key that prevents duplicates.
    pub external_id: String,
}

pub async fn list_by_order<'e, E>(executor: E, order_id: i64) -> Result<Vec<Payment>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, Payment>("SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC")
        .bind(order_id)
        .fetch_all(executor)
        .await
}

/// Lock the payment recorded for one BTCPay invoice (see
/// [`crate::models::invoice::lock_by_btcpay_id`]). Returns `None` when
/// no payment has been recorded yet.
pub async fn lock_by_external_id(
    tx: &mut sqlx::Transaction<'_, MySql>,
    external_id: &str,
) -> Result<Option<Payment>, sqlx::Error> {
    sqlx::query_as::<_, Payment>("SELECT * FROM payments WHERE external_id = ? FOR UPDATE")
        .bind(external_id)
        .fetch_optional(tx.as_mut())
        .await
}

/// Record a payment for an invoice. Only ever called while the matching
/// invoice row is locked and no payment exists for it yet.
pub async fn insert(
    tx: &mut sqlx::Transaction<'_, MySql>,
    payment: &NewPayment,
    now: NaiveDateTime,
) -> Result<i64, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO payments
             (invoice_id, order_id, method, status, amount, currency,
              confirmations, txid, external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(payment.invoice_id)
    .bind(payment.order_id)
    .bind(&payment.method)
    .bind(&payment.status)
    .bind(payment.amount)
    .bind(&payment.currency)
    .bind(payment.confirmations)
    .bind(&payment.txid)
    .bind(&payment.external_id)
    .bind(now)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    Ok(result.last_insert_id() as i64)
}

/// Advance an existing payment towards `status`.
///
/// `WHERE status <> 'confirmed'` mirrors the status-transition rule in
/// the service layer: a confirmed payment is final and can never be
/// downgraded by a late or replayed event. Returns whether the row
/// changed.
pub async fn advance(
    tx: &mut sqlx::Transaction<'_, MySql>,
    payment_id: i64,
    status: &str,
    method: Option<&str>,
    txid: Option<&str>,
    confirmations: i32,
    now: NaiveDateTime,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE payments
         SET status = ?,
             method = COALESCE(?, method),
             txid = COALESCE(?, txid),
             confirmations = GREATEST(confirmations, ?),
             updated_at = ?
         WHERE id = ? AND status <> 'confirmed'",
    )
    .bind(status)
    .bind(method)
    .bind(txid)
    .bind(confirmations)
    .bind(now)
    .bind(payment_id)
    .execute(tx.as_mut())
    .await?;

    Ok(result.rows_affected() == 1)
}
