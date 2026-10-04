//! Invoice-creation service: internal order → BTCPay invoice.
//!
//! Workflow (see the module plan):
//!
//! 1. **Reserve** — one short, database-only transaction: lock the order
//!    row, validate eligibility, decide reuse vs. create, insert an
//!    unpaid placeholder row. The lock is released at commit.
//! 2. **Call BTCPay** — *outside* any transaction; no database
//!    connection is held while the network request runs.
//! 3. **Claim / release** — a second short transaction either fills the
//!    placeholder with the BTCPay fields (success) or deletes it
//!    (failure).
//!
//! The placeholder row is the duplicate-invoice token: concurrent
//! requests see it and either reuse the finished invoice or get a
//! "creation in progress" conflict. Creating an invoice never marks
//! anything paid — `paid_at` stays NULL and order status is untouched;
//! payment confirmation belongs to the webhook phase.

use chrono::{NaiveDateTime, TimeZone, Utc};
use serde::Serialize;
use sqlx::MySqlPool;
use uuid::Uuid;

use crate::btcpay::{BtcpayClient, BtcpayError};
use crate::error::ApiError;
use crate::models::{invoice, order};

/// A placeholder older than this is assumed to belong to a crashed
/// attempt and may be reclaimed.
const PLACEHOLDER_STALE_AFTER_MINUTES: i64 = 5;

/// Payment information returned by `POST /api/v1/orders/{id}/invoice`.
/// Contains no credentials and no internal secrets.
#[derive(Debug, Clone, Serialize)]
pub struct InvoicePaymentInfo {
    pub order_id: i64,
    pub order_number: String,
    pub invoice_id: i64,
    pub invoice_number: String,
    /// Local invoice status. Always unpaid (`pending`) when created.
    pub status: String,
    /// BTCPay checkout page (Lightning payment happens there).
    pub payment_url: Option<String>,
    pub expires_at: Option<NaiveDateTime>,
    /// True when an existing active invoice was returned instead of
    /// creating a new one (HTTP 200 vs 201).
    pub reused: bool,
}

/// What to do with the latest existing invoice for an order.
#[derive(Debug, PartialEq)]
pub(crate) enum InvoiceDecision {
    /// Active, usable invoice — return it, do not create another.
    Reuse(invoice::Invoice),
    /// Its invoice is already paid.
    ConflictPaid,
    /// A placeholder for a creation attempt still in flight.
    InProgress,
    /// A placeholder abandoned by a crashed attempt — remove it first.
    ReclaimStale(i64),
    /// Nothing usable — create a fresh placeholder/invoice.
    CreateFresh,
}

/// Decide based on the latest invoice row. Pure function so the
/// duplicate-prevention rules are unit-testable without a database.
pub(crate) fn decide_invoice_action(
    existing: Option<invoice::Invoice>,
    now: NaiveDateTime,
) -> InvoiceDecision {
    let Some(inv) = existing else {
        return InvoiceDecision::CreateFresh;
    };

    if inv.btcpay_invoice_id.is_none() {
        // Placeholder: in flight if fresh, reclaimable if stale.
        let age_minutes = (now - inv.created_at).num_minutes();
        return if age_minutes < PLACEHOLDER_STALE_AFTER_MINUTES {
            InvoiceDecision::InProgress
        } else {
            InvoiceDecision::ReclaimStale(inv.id)
        };
    }

    if inv.status == "paid" {
        return InvoiceDecision::ConflictPaid;
    }

    let active_status = matches!(inv.status.as_str(), "pending" | "processing");
    let not_expired = inv.expires_at.is_none_or(|expires| expires > now);

    if active_status && not_expired {
        InvoiceDecision::Reuse(inv)
    } else {
        InvoiceDecision::CreateFresh
    }
}

/// Eligibility gate: the order must exist (checked by the caller) and be
/// in a state that may still be invoiced. Amount/currency validity are
/// data invariants enforced by the schema — a violation is a bug, not a
/// client error.
pub(crate) fn validate_order_for_invoicing(order: &order::Order) -> Result<(), ApiError> {
    match order.status.as_str() {
        "paid" => {
            return Err(ApiError::Conflict("order is already paid".to_string()));
        }
        "cancelled" => {
            return Err(ApiError::Conflict("order is cancelled".to_string()));
        }
        "expired" => {
            return Err(ApiError::Conflict("order is expired".to_string()));
        }
        "pending" | "processing" => {}
        other => {
            return Err(ApiError::Internal(format!(
                "order {} has unexpected status {other}",
                order.id
            )));
        }
    }

    if order.amount <= 0 {
        return Err(ApiError::Internal(format!(
            "order {} has non-positive amount {}",
            order.id, order.amount
        )));
    }

    if order.currency.len() != 3 || !order.currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(ApiError::Internal(format!(
            "order {} has malformed currency {:?}",
            order.id, order.currency
        )));
    }

    Ok(())
}

/// Decimal exponent (minor units per major unit) for currencies this
/// service may invoice. Explicit allow-list: an unknown currency is a
/// clear client error, never a guess.
///
/// This is a unit-conversion table (ISO 4217 minor units), **not** an
/// exchange rate. No currency is ever converted into another here.
fn currency_decimals(currency: &str) -> Option<u32> {
    match currency {
        "KES" | "USD" | "EUR" | "GBP" => Some(2),
        "JPY" => Some(0),
        "BTC" => Some(8),
        _ => None,
    }
}

/// Convert BIGINT minor units to the decimal-string amount BTCPay
/// expects, e.g. `1000 KES` → `"10.00"`.
///
/// The currency is passed through unchanged; whether the BTCPay store
/// can actually price it is a runtime question answered by BTCPay
/// itself (see [`BtcpayError::CurrencyUnsupported`]).
pub(crate) fn minor_to_major(amount: i64, currency: &str) -> Result<String, ApiError> {
    let decimals = currency_decimals(currency).ok_or_else(|| {
        ApiError::BadRequest(format!(
            "currency {currency} is not supported for invoicing"
        ))
    })?;

    let factor = 10i64.pow(decimals);
    let major = amount / factor;
    let minor = amount % factor;

    if decimals == 0 {
        Ok(major.to_string())
    } else {
        Ok(format!("{major}.{minor:0>w$}", w = decimals as usize))
    }
}

fn new_invoice_number() -> String {
    format!("INV-{}", Uuid::new_v4().simple())
}

fn unix_to_utc(ts: i64) -> Option<NaiveDateTime> {
    Utc.timestamp_opt(ts, 0).single().map(|dt| dt.naive_utc())
}

/// Detect a MySQL/MariaDB duplicate-key error (1062 / SQLSTATE 23000).
fn is_duplicate_key(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db) => {
            db.is_unique_violation()
                || db.code().as_deref() == Some("1062")
                || db.message().contains("Duplicate entry")
        }
        _ => false,
    }
}

/// Map a BTCPay failure to the API error surface. Details are carried
/// for server-side logging (rendered by `ApiError::into_response`);
/// credentials never appear in them. Shared with the webhook service so
/// both paths report provider failures identically.
pub(crate) fn map_btcpay_error(err: BtcpayError) -> ApiError {
    match err {
        BtcpayError::CurrencyUnsupported { currency, .. } => {
            ApiError::ProviderCurrencyUnsupported { currency }
        }
        BtcpayError::Unauthorized => {
            ApiError::PaymentProvider("btcpay rejected the API key (401)".to_string())
        }
        BtcpayError::Forbidden => ApiError::PaymentProvider(
            "btcpay API key lacks permission btcpay.store.cancreateinvoice (403)".to_string(),
        ),
        BtcpayError::Transport(detail) => ApiError::ProviderUnavailable(detail),
        BtcpayError::Provider { status } => {
            ApiError::ProviderUnavailable(format!("btcpay returned HTTP {status}"))
        }
        BtcpayError::Rejected { status, detail } => ApiError::PaymentProvider(format!(
            "btcpay rejected invoice creation ({status}): {detail}"
        )),
        BtcpayError::InvalidResponse(detail) => {
            ApiError::PaymentProvider(format!("malformed btcpay response: {detail}"))
        }
    }
}

/// Create (or reuse) a BTCPay invoice for `order_id`.
///
/// Returns the payment information plus `created`: `true` when a new
/// invoice was created (HTTP 201), `false` when an existing active
/// invoice was reused (HTTP 200).
pub async fn create_for_order(
    pool: &MySqlPool,
    btcpay: &BtcpayClient,
    order_id: i64,
) -> Result<(InvoicePaymentInfo, bool), ApiError> {
    // ---- Step 1: reserve placeholder (short, database-only tx) ----
    let mut tx = pool.begin().await?;

    let order = order::lock_by_id(&mut tx, order_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("order {order_id} not found")))?;

    validate_order_for_invoicing(&order)?;

    // Minor→major conversion happens before reserving: an unsupported
    // currency aborts with the transaction still empty (rolled back).
    let amount_major = minor_to_major(order.amount, &order.currency)?;

    let existing = invoice::find_latest_by_order(&mut *tx, order_id).await?;
    let now = Utc::now().naive_utc();

    match decide_invoice_action(existing, now) {
        InvoiceDecision::Reuse(inv) => {
            tx.commit().await?;
            tracing::debug!(
                order_id,
                order_number = %order.order_number,
                invoice_id = inv.id,
                "reusing active btcpay invoice"
            );
            return Ok((
                InvoicePaymentInfo {
                    order_id: order.id,
                    order_number: order.order_number.clone(),
                    invoice_id: inv.id,
                    invoice_number: inv.invoice_number,
                    status: inv.status,
                    payment_url: inv.payment_url,
                    expires_at: inv.expires_at,
                    reused: true,
                },
                false,
            ));
        }
        InvoiceDecision::ConflictPaid => {
            return Err(ApiError::Conflict(
                "invoice for this order is already paid".to_string(),
            ));
        }
        InvoiceDecision::InProgress => {
            return Err(ApiError::Conflict(
                "invoice creation already in progress; retry shortly".to_string(),
            ));
        }
        InvoiceDecision::ReclaimStale(stale_id) => {
            tracing::warn!(
                order_id,
                stale_invoice_id = stale_id,
                "reclaiming stale invoice placeholder"
            );
            invoice::delete_placeholder(&mut tx, stale_id).await?;
        }
        InvoiceDecision::CreateFresh => {}
    }

    let invoice_number = new_invoice_number();
    let placeholder_id = invoice::insert_placeholder(
        &mut tx,
        order_id,
        &invoice_number,
        order.amount,
        &order.currency,
        now,
    )
    .await?;
    // Lock released here. Nothing database-related is held from now
    // until step 3.
    tx.commit().await?;

    // ---- Step 2: BTCPay HTTP call, outside any transaction ----
    tracing::info!(
        order_id,
        order_number = %order.order_number,
        currency = %order.currency,
        amount = %amount_major,
        "creating btcpay invoice"
    );

    let created = match btcpay
        .create_invoice(&amount_major, &order.currency, &order.order_number)
        .await
    {
        Ok(created) => created,
        Err(err) => {
            // Release the placeholder so a retry can start fresh.
            let mut release = pool.begin().await?;
            invoice::delete_placeholder(&mut release, placeholder_id).await?;
            release.commit().await?;

            tracing::error!(
                order_id,
                order_number = %order.order_number,
                error = %err,
                "btcpay invoice creation failed"
            );
            return Err(map_btcpay_error(err));
        }
    };

    // ---- Step 3: claim placeholder (short, database-only tx) ----
    let expires_at = created.expiration_time.and_then(unix_to_utc);

    let mut claim_tx = pool.begin().await?;
    let claim_result = invoice::claim_btcpay(
        &mut claim_tx,
        placeholder_id,
        &created.id,
        &created.checkout_link,
        expires_at,
    )
    .await;

    let claimed = match claim_result {
        Ok(claimed) => claimed,
        Err(err) if is_duplicate_key(&err) => {
            // Provider returned an invoice id we already store (broken
            // provider or restored database). Release the placeholder
            // so the order is not stuck, then surface a provider error.
            drop(claim_tx);
            let mut release = pool.begin().await?;
            invoice::delete_placeholder(&mut release, placeholder_id).await?;
            release.commit().await?;

            tracing::error!(
                order_id,
                order_number = %order.order_number,
                "btcpay returned an invoice id that already exists locally"
            );
            return Err(ApiError::PaymentProvider(
                "provider returned an already-used invoice id".to_string(),
            ));
        }
        Err(err) => return Err(err.into()),
    };

    if !claimed {
        return Err(ApiError::Internal(format!(
            "invoice placeholder {placeholder_id} could not be claimed after btcpay success"
        )));
    }
    claim_tx.commit().await?;

    tracing::info!(
        order_id,
        order_number = %order.order_number,
        invoice_id = placeholder_id,
        btcpay_invoice_id = %created.id,
        btcpay_status = %created.status,
        "btcpay invoice created"
    );

    Ok((
        InvoicePaymentInfo {
            order_id: order.id,
            order_number: order.order_number,
            invoice_id: placeholder_id,
            invoice_number,
            status: "pending".to_string(),
            payment_url: Some(created.checkout_link),
            expires_at,
            reused: false,
        },
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn order_with(status: &str, amount: i64, currency: &str) -> order::Order {
        let now = NaiveDate::from_ymd_opt(2026, 9, 30)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        order::Order {
            id: 1,
            order_number: "ORD-1".to_string(),
            user_id: 1,
            amount,
            currency: currency.to_string(),
            description: None,
            status: status.to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    fn invoice_row(
        id: i64,
        status: &str,
        btcpay_id: Option<&str>,
        expires_at: Option<NaiveDateTime>,
        created_at: NaiveDateTime,
    ) -> invoice::Invoice {
        invoice::Invoice {
            id,
            order_id: 1,
            invoice_number: format!("INV-{id}"),
            amount: 1000,
            currency: "KES".to_string(),
            status: status.to_string(),
            btcpay_invoice_id: btcpay_id.map(str::to_string),
            payment_url: btcpay_id.map(|_| "https://btcpay.example/i/x".to_string()),
            expires_at,
            paid_at: None,
            created_at,
            updated_at: created_at,
        }
    }

    fn now() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, 30)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    // --- amount / currency --------------------------------------------

    #[test]
    fn minor_to_major_converts_known_currencies() {
        assert_eq!(minor_to_major(1000, "KES").unwrap(), "10.00");
        assert_eq!(minor_to_major(1, "KES").unwrap(), "0.01");
        assert_eq!(minor_to_major(999, "USD").unwrap(), "9.99");
        assert_eq!(minor_to_major(500, "JPY").unwrap(), "500");
        assert_eq!(minor_to_major(100_000_000, "BTC").unwrap(), "1.00000000");
        assert_eq!(minor_to_major(1, "BTC").unwrap(), "0.00000001");
    }

    #[test]
    fn unknown_currency_is_a_clear_client_error() {
        let err = minor_to_major(1000, "XYZ").unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
        assert!(err.to_string().contains("XYZ"));
    }

    // --- order validation ---------------------------------------------

    #[test]
    fn pending_and_processing_orders_are_eligible() {
        assert!(validate_order_for_invoicing(&order_with("pending", 1000, "KES")).is_ok());
        assert!(validate_order_for_invoicing(&order_with("processing", 1000, "KES")).is_ok());
    }

    #[test]
    fn paid_cancelled_expired_orders_are_conflicts() {
        for status in ["paid", "cancelled", "expired"] {
            let err = validate_order_for_invoicing(&order_with(status, 1000, "KES")).unwrap_err();
            assert!(matches!(err, ApiError::Conflict(_)), "status {status}");
        }
    }

    #[test]
    fn invalid_amount_or_currency_shape_is_internal() {
        assert!(matches!(
            validate_order_for_invoicing(&order_with("pending", 0, "KES")),
            Err(ApiError::Internal(_))
        ));
        assert!(matches!(
            validate_order_for_invoicing(&order_with("pending", 1000, "kes")),
            Err(ApiError::Internal(_))
        ));
    }

    // --- duplicate-invoice decision -----------------------------------

    #[test]
    fn no_existing_invoice_means_create_fresh() {
        assert_eq!(
            decide_invoice_action(None, now()),
            InvoiceDecision::CreateFresh
        );
    }

    #[test]
    fn active_unexpired_invoice_is_reused() {
        let inv = invoice_row(
            7,
            "pending",
            Some("btcpay-1"),
            Some(now() + chrono::Duration::minutes(30)),
            now(),
        );
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::Reuse(invoice_row(
                7,
                "pending",
                Some("btcpay-1"),
                Some(now() + chrono::Duration::minutes(30)),
                now()
            ))
        );
    }

    #[test]
    fn expired_invoice_is_not_reused() {
        let inv = invoice_row(
            8,
            "pending",
            Some("btcpay-1"),
            Some(now() - chrono::Duration::minutes(1)),
            now(),
        );
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::CreateFresh
        );
    }

    #[test]
    fn paid_invoice_conflicts() {
        let inv = invoice_row(9, "paid", Some("btcpay-1"), None, now());
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::ConflictPaid
        );
    }

    #[test]
    fn cancelled_invoice_is_not_reused() {
        let inv = invoice_row(10, "cancelled", Some("btcpay-1"), None, now());
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::CreateFresh
        );
    }

    #[test]
    fn fresh_placeholder_blocks_duplicate_creation() {
        let inv = invoice_row(11, "pending", None, None, now());
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::InProgress
        );
    }

    #[test]
    fn stale_placeholder_is_reclaimed() {
        let created = now() - chrono::Duration::minutes(10);
        let inv = invoice_row(12, "pending", None, None, created);
        assert_eq!(
            decide_invoice_action(Some(inv), now()),
            InvoiceDecision::ReclaimStale(12)
        );
    }
}
