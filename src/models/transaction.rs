//! `transactions` table — an append-only ledger of money movements.
//!
//! `amount` is signed: refunds and fees are negative, payments positive.

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::MySql;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Transaction {
    pub id: i64,
    pub payment_id: Option<i64>,
    pub order_id: Option<i64>,
    #[sqlx(rename = "txn_type")]
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: i64,
    pub currency: String,
    pub reference: Option<String>,
    pub created_at: NaiveDateTime,
}

pub async fn list_by_order<'e, E>(
    executor: E,
    order_id: i64,
) -> Result<Vec<Transaction>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    sqlx::query_as::<_, Transaction>(
        "SELECT * FROM transactions WHERE order_id = ? ORDER BY id ASC",
    )
    .bind(order_id)
    .fetch_all(executor)
    .await
}

/// Append the ledger entry for a settled payment.
///
/// Callers must only invoke this when the invoice actually transitions
/// to `paid` (inside the invoice row lock): the table has no uniqueness
/// constraint, so the state transition — not the row itself — is what
/// keeps duplicate webhook deliveries from writing the entry twice.
/// `amount` is positive (a payment), `reference` is the BTCPay invoice
/// id so the entry can be tied back to the provider.
pub async fn insert_payment(
    tx: &mut sqlx::Transaction<'_, MySql>,
    payment_id: i64,
    order_id: i64,
    amount: i64,
    currency: &str,
    reference: &str,
) -> Result<i64, sqlx::Error> {
    let result = sqlx::query(
        "INSERT INTO transactions
             (payment_id, order_id, txn_type, amount, currency, reference)
         VALUES (?, ?, 'payment', ?, ?, ?)",
    )
    .bind(payment_id)
    .bind(order_id)
    .bind(amount)
    .bind(currency)
    .bind(reference)
    .execute(tx.as_mut())
    .await?;

    Ok(result.last_insert_id() as i64)
}
