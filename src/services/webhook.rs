//! BTCPay webhook service: authenticate, re-verify, apply — idempotently.
//!
//! Workflow, in order:
//!
//! 1. **Authenticate** — HMAC-SHA256 of the raw body against
//!    `BTCPAY_WEBHOOK_SECRET` ([`verify_signature`]). Done on the raw
//!    bytes, before anything is parsed.
//! 2. **Scope** — only invoice events for the configured store are
//!    considered; everything else is acknowledged as a no-op.
//! 3. **Re-verify** — the invoice is re-read from BTCPay
//!    ([`BtcpayClient::get_invoice`]) and cross-checked against the
//!    locally stored invoice. A webhook payload on its own is *never*
//!    enough to mark an order paid; if BTCPay cannot be reached the
//!    whole delivery fails with 5xx and BTCPay retries later.
//! 4. **Apply** — one short database transaction: lock the local
//!    invoice row, then move invoice, payment, order and the ledger
//!    entry forward together.
//!
//! Idempotency comes from two independent guards, so duplicate or
//! redelivered events cannot create duplicate payments:
//!
//! * `payments.external_id` is UNIQUE and holds the BTCPay invoice id —
//!   there is at most one payment row per invoice.
//! * the invoice row is locked `FOR UPDATE` and only *forward*
//!   transitions are applied ([`advance_status`]), so the ledger entry
//!   is written exactly once, on the first settling event.

use chrono::{NaiveDateTime, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use sqlx::{MySql, MySqlPool, Transaction};

use crate::btcpay::{AuthorizedEvents, BtcpayClient, BtcpayError, BtcpayInvoice, WebhookRequest};
use crate::error::ApiError;
use crate::models::{invoice, order, payment, transaction as ledger};
use crate::services::invoice::{map_btcpay_error, minor_to_major};

/// Header BTCPay signs every delivery with. Looked up case-insensitively
/// through [`axum::http::HeaderMap`].
pub const SIGNATURE_HEADER: &str = "BTCPay-Sig";

/// Prefix BTCPay puts in front of the hex digest (`sha256=<hex>`).
/// Matched case-insensitively; a bare hex digest is accepted too, since
/// the digest itself carries the authentication.
pub(crate) const SIGNATURE_PREFIX: &str = "sha256=";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/// Verify a `BTCPay-Sig` header against the raw request body.
///
/// The signature is `HMAC-SHA256(secret, raw_body)` in lower/upper-case
/// hex, optionally prefixed with `sha256=`. Comparison happens inside
/// `hmac` in constant time; a malformed header simply fails.
///
/// Returns `false` for a missing or unparsable header, so callers can
/// report one indistinguishable "invalid signature" error.
pub fn verify_signature(secret: &str, body: &[u8], header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };

    let header = header.trim();
    // BTCPay issues `sha256=<hex>`; match the prefix case-insensitively
    // so a proxy that rewrites header casing cannot break verification.
    let hex = match header.get(..SIGNATURE_PREFIX.len()) {
        Some(prefix) if prefix.eq_ignore_ascii_case(SIGNATURE_PREFIX) => {
            &header[SIGNATURE_PREFIX.len()..]
        }
        _ => header,
    };

    let Some(expected) = decode_hex(hex) else {
        return false;
    };

    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// Decode a hex string into bytes. Rejects odd lengths and non-hex
/// characters instead of guessing.
fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let bytes = input.as_bytes();
    (0..input.len())
        .step_by(2)
        .map(|i| {
            let hi = hex_val(bytes[i])?;
            let lo = hex_val(bytes[i + 1])?;
            Some((hi << 4) | lo)
        })
        .collect()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// A BTCPay webhook delivery.
///
/// The payload is a single flat JSON object (envelope fields and event
/// fields side by side). Every field is optional here: unknown and
/// future fields are dropped by serde, and completeness is checked by
/// [`WebhookEvent::validate`] rather than by the parser, so an
/// unexpected shape produces a readable 400 instead of a serde error.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookEvent {
    #[serde(default)]
    pub delivery_id: Option<String>,
    /// Set on retried deliveries. Idempotency does not depend on it —
    /// the database guards below make any combination of deliveries and
    /// redeliveries safe — but it is useful when correlating logs.
    #[serde(default)]
    pub original_delivery_id: Option<String>,
    #[serde(default)]
    pub is_redelivery: bool,
    /// `InvoiceSettled`, `InvoiceProcessing`, `InvoiceExpired`, …
    #[serde(rename = "type", default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub store_id: Option<String>,
    #[serde(default)]
    pub invoice_id: Option<String>,
    /// `BTC` (on-chain) or `BTC-LN` (Lightning) — which rail the
    /// payment arrived on.
    #[serde(default)]
    pub payment_method_id: Option<String>,
    #[serde(default)]
    pub payment: Option<WebhookPayment>,
}

/// Payment attached to `InvoiceReceivedPayment` /
/// `InvoicePaymentSettled` deliveries.
#[derive(Debug, Clone, Deserialize)]
pub struct WebhookPayment {
    /// Provider-side payment id (transaction id / payment hash).
    #[serde(default)]
    pub id: Option<String>,
}

impl WebhookEvent {
    /// Reject payloads that cannot possibly be acted on, with a message
    /// safe to show the caller. Nothing is logged or stored here.
    pub fn validate(&self) -> Result<(), ApiError> {
        let event_type = self
            .event_type
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| ApiError::BadRequest("webhook payload has no event type".to_string()))?;

        if is_invoice_event(event_type) && self.invoice_id.as_deref().is_none_or(|i| i.is_empty()) {
            return Err(ApiError::BadRequest(format!(
                "invoice event {event_type} has no invoiceId"
            )));
        }

        Ok(())
    }
}

/// True for every `Invoice*` event type. Anything else (payouts, payment
/// requests, …) is acknowledged without touching the database.
pub fn is_invoice_event(event_type: &str) -> bool {
    event_type
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("invoice"))
}

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

/// What a provider invoice status means for our records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    /// `New` — created, no payment seen.
    Pending,
    /// `Processing` — payment seen, not settled.
    Processing,
    /// `Settled` — paid in full and confirmed by the provider.
    Paid,
    /// `Expired` — the time window lapsed without full payment.
    Expired,
    /// `Invalid` — the payment attempt was rejected by the provider.
    Invalid,
}

impl Target {
    /// Local invoice/payment status this target maps to.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Paid => "paid",
            Self::Expired => "expired",
            Self::Invalid => "cancelled",
        }
    }

    /// Short action name reported back to the caller / log.
    fn action(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Paid => "paid",
            Self::Expired => "expired",
            Self::Invalid => "failed",
        }
    }
}

/// Map a Greenfield invoice status onto a [`Target`].
///
/// Returns `None` for anything this application does not know how to
/// represent — the delivery is then acknowledged and ignored instead of
/// being guessed at.
pub(crate) fn target_for_status(status: &str) -> Option<Target> {
    match status {
        "New" => Some(Target::Pending),
        "Processing" => Some(Target::Processing),
        "Settled" => Some(Target::Paid),
        "Expired" => Some(Target::Expired),
        "Invalid" => Some(Target::Invalid),
        _ => None,
    }
}

/// Decide whether a status may be written.
///
/// `paid`/`confirmed` are terminal: a late or replayed event can never
/// take money back. Everything else may move to the desired status
/// (including backwards — the provider is the source of truth, and a
/// downgrade it reports really happened). Returns the status to write,
/// or `None` when nothing should change.
pub(crate) fn advance_status<'a>(current: &str, desired: &'a str) -> Option<&'a str> {
    if current == desired {
        return None;
    }
    match current {
        "paid" | "confirmed" => None,
        _ => Some(desired),
    }
}

/// Payment status a target implies, or `None` when no payment has been
/// observed yet (nothing to record).
pub(crate) fn desired_payment_status(target: Target) -> Option<&'static str> {
    match target {
        Target::Pending => None,
        Target::Processing => Some("processing"),
        Target::Paid => Some("confirmed"),
        Target::Expired | Target::Invalid => Some("failed"),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Which rail did the payment arrive on? BTCPay's payment method ids
/// are `BTC` (on-chain) and `BTC-LN` (Lightning). Anything
/// unrecognised falls back to the schema default.
pub(crate) fn method_from_payment_method_id(payment_method_id: &str) -> String {
    let upper = payment_method_id.to_ascii_uppercase();
    if upper.contains("LN") || upper.contains("LIGHTNING") {
        "lightning".to_string()
    } else {
        "bitcoin".to_string()
    }
}

/// Keep a provider-supplied payment id only when it fits the `txid`
/// column and cannot smuggle anything unexpected into the database.
pub(crate) fn sanitize_txid(id: &str) -> Option<String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return None;
    }
    Some(id.to_string())
}

/// Compare two decimal strings by value: `"10.00"` equals `"10"`,
/// but `"10.01"` does not. Leading zeros and trailing fractional
/// zeros are insignificant; anything that is not a plain non-negative
/// decimal compares false.
pub(crate) fn decimals_equal(a: &str, b: &str) -> bool {
    fn normalize(value: &str) -> Option<(String, String)> {
        let (int, frac) = value.split_once('.').unwrap_or((value, ""));
        if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        if !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let int = int.trim_start_matches('0');
        let int = if int.is_empty() { "0" } else { int };
        Some((int.to_string(), frac.trim_end_matches('0').to_string()))
    }

    match (normalize(a), normalize(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Result of processing one verified delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Records moved forward.
    Applied(&'static str),
    /// Already in the target state — a duplicate delivery.
    Unchanged,
    /// Verified, but nothing to do (other store, unknown invoice,
    /// event type outside our scope, unknown provider status).
    Ignored(String),
}

impl Outcome {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Applied(_) => "applied",
            Self::Unchanged => "unchanged",
            Self::Ignored(_) => "ignored",
        }
    }

    pub fn action(&self) -> Option<&'static str> {
        match self {
            Self::Applied(action) => Some(action),
            _ => None,
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Ignored(reason) => Some(reason),
            _ => None,
        }
    }
}

/// Apply one already-authenticated webhook delivery.
///
/// `event` must have passed [`WebhookEvent::validate`].
pub async fn process_event(
    pool: &MySqlPool,
    btcpay: &BtcpayClient,
    event: &WebhookEvent,
) -> Result<Outcome, ApiError> {
    let event_type = event.event_type.as_deref().unwrap_or_default();

    if !is_invoice_event(event_type) {
        return Ok(Outcome::Ignored(format!(
            "event type {event_type} is not an invoice event"
        )));
    }

    // The signature proves the delivery came from whoever holds the
    // secret; the store id proves it concerns *our* store.
    if let Some(store_id) = event.store_id.as_deref()
        && store_id != btcpay.store_id()
    {
        tracing::warn!(
            event_type,
            invoice_id = event.invoice_id.as_deref().unwrap_or_default(),
            "webhook store id does not match the configured store; ignoring"
        );
        return Ok(Outcome::Ignored(
            "webhook belongs to a different store".to_string(),
        ));
    }

    let invoice_id = event.invoice_id.as_deref().unwrap_or_default();

    // ---- Re-verify against the provider ---------------------------------
    let remote = match btcpay.get_invoice(invoice_id).await {
        Ok(remote) => remote,
        Err(BtcpayError::Rejected { status: 404, .. }) => {
            tracing::error!(
                event_type,
                invoice_id,
                "payment provider does not know this invoice; not applying anything"
            );
            return Ok(Outcome::Ignored(
                "invoice not found at the payment provider".to_string(),
            ));
        }
        Err(error) => return Err(map_btcpay_error(error)),
    };

    if remote.id != invoice_id {
        return Err(ApiError::PaymentProvider(
            "payment provider returned a different invoice than requested".to_string(),
        ));
    }

    let Some(target) = target_for_status(&remote.status) else {
        tracing::warn!(
            event_type,
            invoice_id,
            status = %remote.status,
            "unhandled payment provider status; ignoring webhook"
        );
        return Ok(Outcome::Ignored(format!(
            "provider status {} is not handled",
            remote.status
        )));
    };

    // ---- Apply -----------------------------------------------------------
    let mut tx = pool.begin().await?;

    let Some(local) = invoice::lock_by_btcpay_id(&mut tx, invoice_id).await? else {
        // Nothing written yet — dropping the transaction rolls it back.
        tracing::warn!(
            event_type,
            invoice_id,
            "webhook refers to an invoice this application never created"
        );
        return Ok(Outcome::Ignored(
            "no local invoice matches this provider invoice".to_string(),
        ));
    };

    // Refuse to settle an invoice whose amount or currency differs from
    // what the order says: a mismatch means tampering or a misconfigured
    // provider, never a legitimate payment.
    verify_matches(&local, &remote)?;

    let now = Utc::now().naive_utc();
    let invoice_transition = advance_status(&local.status, target.as_str());
    let settles_now = invoice_transition == Some("paid");

    let method = event
        .payment_method_id
        .as_deref()
        .map(method_from_payment_method_id);
    let txid = event
        .payment
        .as_ref()
        .and_then(|p| p.id.as_deref())
        .and_then(sanitize_txid);

    let (payment_id, payment_changed) = apply_payment(
        &mut tx,
        &local,
        target,
        method.as_deref(),
        txid.as_deref(),
        now,
    )
    .await?;

    // The ledger entry is written exactly once: only when this delivery
    // is the one that moves the invoice to `paid`.
    if settles_now {
        ledger::insert_payment(
            &mut tx,
            payment_id,
            local.order_id,
            local.amount,
            &local.currency,
            invoice_id,
        )
        .await?;
    }

    let mut changed = payment_changed || settles_now;

    if let Some(new_status) = invoice_transition {
        invoice::set_status(
            &mut tx,
            local.id,
            new_status,
            (new_status == "paid").then_some(now),
            now,
        )
        .await?;
        changed = true;
    }

    match target {
        Target::Paid => {
            changed |= order::mark_paid(&mut tx, local.order_id, now).await?;
        }
        Target::Expired => {
            changed |= order::mark_expired(&mut tx, local.order_id, local.id, now).await?;
        }
        Target::Pending | Target::Processing | Target::Invalid => {}
    }

    tx.commit().await?;

    tracing::info!(
        event_type,
        invoice_id,
        order_id = local.order_id,
        provider_status = %remote.status,
        local_status = target.as_str(),
        "webhook applied"
    );

    Ok(if changed {
        Outcome::Applied(target.action())
    } else {
        Outcome::Unchanged
    })
}

/// Cross-check the provider's invoice against the stored one. Both
/// sides are decimal strings in major units; no exchange rate is ever
/// involved.
fn verify_matches(local: &invoice::Invoice, remote: &BtcpayInvoice) -> Result<(), ApiError> {
    if let Some(remote_currency) = remote.currency.as_deref()
        && !remote_currency.eq_ignore_ascii_case(&local.currency)
    {
        tracing::error!(
            local_currency = %local.currency,
            provider_currency = %remote_currency,
            "invoice currency mismatch between provider and database"
        );
        return Err(ApiError::PaymentProvider(
            "invoice currency does not match the stored order".to_string(),
        ));
    }

    if let Some(remote_amount) = remote.amount.as_deref() {
        let expected = minor_to_major(local.amount, &local.currency).map_err(|_| {
            ApiError::Internal(format!(
                "invoice {} has unusable amount {} {}",
                local.id, local.amount, local.currency
            ))
        })?;

        if !decimals_equal(&expected, remote_amount) {
            tracing::error!(
                expected,
                provider_amount = %remote_amount,
                "invoice amount mismatch between provider and database"
            );
            return Err(ApiError::PaymentProvider(
                "invoice amount does not match the stored order".to_string(),
            ));
        }
    }

    Ok(())
}

/// Create or advance the single payment row for an invoice.
///
/// Returns `(payment_id, changed)`. `payment_id` is `0` only when no
/// payment row exists and none is due yet (nothing has been observed).
async fn apply_payment(
    tx: &mut Transaction<'_, MySql>,
    local: &invoice::Invoice,
    target: Target,
    method: Option<&str>,
    txid: Option<&str>,
    now: NaiveDateTime,
) -> Result<(i64, bool), ApiError> {
    let external_id = local
        .btcpay_invoice_id
        .clone()
        .ok_or_else(|| ApiError::Internal(format!("invoice {} has no btcpay id", local.id)))?;

    let existing = payment::lock_by_external_id(tx, &external_id).await?;

    let Some(row) = existing else {
        // Nothing recorded yet: only create a row when the provider has
        // actually reported a payment (an expired invoice with no
        // payment at all leaves no payment record behind).
        let Some(status) = desired_payment_status(target) else {
            return Ok((0, false));
        };
        if status == "failed" && target == Target::Expired {
            return Ok((0, false));
        }

        let new = payment::NewPayment {
            invoice_id: local.id,
            order_id: local.order_id,
            method: method.unwrap_or("bitcoin").to_string(),
            status: status.to_string(),
            amount: local.amount,
            currency: local.currency.clone(),
            confirmations: if status == "confirmed" { 1 } else { 0 },
            txid: txid.map(str::to_string),
            external_id,
        };
        let id = payment::insert(tx, &new, now).await?;
        tracing::info!(
            payment_id = id,
            order_id = local.order_id,
            status = %new.status,
            "payment recorded"
        );
        return Ok((id, true));
    };

    let Some(desired) = desired_payment_status(target) else {
        return Ok((row.id, false));
    };
    let Some(status) = advance_status(&row.status, desired) else {
        return Ok((row.id, false));
    };

    let changed = payment::advance(
        tx,
        row.id,
        status,
        method,
        txid,
        if status == "confirmed" { 1 } else { 0 },
        now,
    )
    .await?;

    Ok((row.id, changed))
}

// ---------------------------------------------------------------------------
// Optional startup registration
// ---------------------------------------------------------------------------

/// Make sure a webhook pointing at `url` exists on the store.
///
/// Called at startup when `BTCPAY_WEBHOOK_URL` is set: an existing
/// webhook with the same URL is updated (so URL, secret and enablement
/// stay in sync with the environment), a missing one is created. A
/// failure is logged by the caller and never prevents the server from
/// booting — registration can also be done in the BTCPay UI.
pub async fn ensure_registered(
    btcpay: &BtcpayClient,
    url: &str,
    secret: Option<&str>,
) -> Result<(), BtcpayError> {
    let request = WebhookRequest {
        url: url.to_string(),
        secret: secret.map(str::to_string),
        enabled: true,
        automatic_redelivery: true,
        authorized_events: AuthorizedEvents { everything: true },
    };

    let existing = btcpay.list_webhooks().await?;
    match existing.iter().find(|hook| hook.url == url) {
        Some(hook) => {
            btcpay.update_webhook(&hook.id, &request).await?;
        }
        None => {
            btcpay.create_webhook(&request).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- signature verification ----------------------------------------

    /// RFC 4231 test case 2 — proves the HMAC and hex decoding are
    /// correct independently of BTCPay.
    #[test]
    fn verifies_a_known_hmac_sha256_vector() {
        let body = b"what do ya want for nothing?";
        let signature = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        assert!(verify_signature("Jefe", body, Some(signature)));
        assert!(verify_signature(
            "Jefe",
            body,
            Some(&format!("sha256={signature}"))
        ));
        assert!(verify_signature(
            "Jefe",
            body,
            Some(&format!("SHA256={signature}"))
        ));
    }

    #[test]
    fn rejects_a_signature_for_another_secret() {
        let signature = {
            let mut mac = Hmac::<Sha256>::new_from_slice(b"right").unwrap();
            mac.update(b"{}");
            hex_encode(&mac.finalize().into_bytes())
        };
        assert!(verify_signature("right", b"{}", Some(&signature)));
        assert!(!verify_signature("wrong", b"{}", Some(&signature)));
        // even with the right secret, a different body must fail
        assert!(!verify_signature("right", b"[]", Some(&signature)));
    }

    #[test]
    fn rejects_missing_or_malformed_signatures() {
        assert!(!verify_signature("s", b"{}", None));
        assert!(!verify_signature("s", b"{}", Some("")));
        assert!(!verify_signature("s", b"{}", Some("sha256=")));
        assert!(!verify_signature("s", b"{}", Some("not-hex-at-all")));
        assert!(!verify_signature("s", b"{}", Some("abc"))); // odd length
        assert!(!verify_signature(
            "s",
            b"{}",
            Some("zz".repeat(32).as_str())
        ));
    }

    #[test]
    fn decodes_hex_leniently_but_strictly() {
        assert_eq!(decode_hex("0aFF").unwrap(), vec![0x0a, 0xff]);
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
        assert!(decode_hex("0").is_none());
        assert!(decode_hex("0g").is_none());
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // --- payload validation --------------------------------------------

    #[test]
    fn parses_a_realistic_btcpay_delivery() {
        let raw = r#"{
            "deliveryId": "dlv_1",
            "webhookId": "wh_1",
            "originalDeliveryId": "dlv_1",
            "isRedelivery": false,
            "type": "InvoiceSettled",
            "timestamp": 1793449100,
            "storeId": "Store123",
            "invoiceId": "HMprBnL9BTXWuPvpoKBS6e",
            "manuallyMarked": false,
            "overPaid": false
        }"#;
        let event: WebhookEvent = serde_json::from_str(raw).unwrap();
        assert_eq!(event.event_type.as_deref(), Some("InvoiceSettled"));
        assert_eq!(event.invoice_id.as_deref(), Some("HMprBnL9BTXWuPvpoKBS6e"));
        assert_eq!(event.store_id.as_deref(), Some("Store123"));
        assert!(!event.is_redelivery);
        event.validate().unwrap();
    }

    #[test]
    fn parses_a_payment_delivery() {
        let raw = r#"{
            "deliveryId": "dlv_2",
            "type": "InvoiceReceivedPayment",
            "storeId": "Store123",
            "invoiceId": "inv1",
            "paymentMethodId": "BTC-LN",
            "payment": {
                "id": "aa:bb",
                "receivedDate": 1793449100,
                "value": "10.00",
                "fee": "0.00",
                "status": "Processing",
                "destination": "lnbc1..."
            }
        }"#;
        let event: WebhookEvent = serde_json::from_str(raw).unwrap();
        assert_eq!(event.payment_method_id.as_deref(), Some("BTC-LN"));
        let payment = event.payment.as_ref().unwrap();
        assert_eq!(payment.id.as_deref(), Some("aa:bb"));
    }

    #[test]
    fn validation_requires_type_and_invoice_id() {
        assert!(WebhookEvent::default().validate().is_err());

        let mut event = WebhookEvent {
            event_type: Some("InvoiceSettled".to_string()),
            ..Default::default()
        };
        assert!(event.validate().is_err(), "invoice event without invoiceId");

        event.invoice_id = Some("inv1".to_string());
        assert!(event.validate().is_ok());

        // non-invoice events do not need an invoiceId
        let event = WebhookEvent {
            event_type: Some("PayoutCreated".to_string()),
            ..Default::default()
        };
        assert!(event.validate().is_ok());

        let event = WebhookEvent {
            event_type: Some("   ".to_string()),
            invoice_id: Some("inv1".to_string()),
            ..Default::default()
        };
        assert!(event.validate().is_err());
    }

    #[test]
    fn scope_is_limited_to_invoice_events() {
        for event_type in [
            "InvoiceSettled",
            "InvoiceCreated",
            "invoiceexpired",
            "InvoicePaymentSettled",
        ] {
            assert!(is_invoice_event(event_type), "{event_type}");
        }
        for event_type in [
            "PayoutCreated",
            "PaymentRequestCompleted",
            "",
            "Inv",
            "Subscriptions",
        ] {
            assert!(!is_invoice_event(event_type), "{event_type}");
        }
    }

    // --- status mapping ---------------------------------------------------

    #[test]
    fn provider_statuses_map_to_targets() {
        assert_eq!(target_for_status("New"), Some(Target::Pending));
        assert_eq!(target_for_status("Processing"), Some(Target::Processing));
        assert_eq!(target_for_status("Settled"), Some(Target::Paid));
        assert_eq!(target_for_status("Expired"), Some(Target::Expired));
        assert_eq!(target_for_status("Invalid"), Some(Target::Invalid));
        assert_eq!(target_for_status("SomethingNew"), None);
        assert_eq!(target_for_status(""), None);
    }

    #[test]
    fn forward_transitions_are_written_and_terminal_states_are_sticky() {
        // forward
        assert_eq!(advance_status("pending", "processing"), Some("processing"));
        assert_eq!(advance_status("pending", "paid"), Some("paid"));
        assert_eq!(advance_status("processing", "paid"), Some("paid"));
        assert_eq!(advance_status("expired", "paid"), Some("paid"));
        assert_eq!(advance_status("pending", "expired"), Some("expired"));
        assert_eq!(advance_status("pending", "cancelled"), Some("cancelled"));

        // no-ops
        assert_eq!(advance_status("paid", "paid"), None);
        assert_eq!(advance_status("processing", "processing"), None);

        // terminal states never regress — this is what makes a replayed
        // or out-of-order event harmless
        assert_eq!(advance_status("paid", "expired"), None);
        assert_eq!(advance_status("paid", "pending"), None);
        assert_eq!(advance_status("confirmed", "processing"), None);
    }

    #[test]
    fn payment_statuses_follow_the_target() {
        assert_eq!(desired_payment_status(Target::Pending), None);
        assert_eq!(
            desired_payment_status(Target::Processing),
            Some("processing")
        );
        assert_eq!(desired_payment_status(Target::Paid), Some("confirmed"));
        assert_eq!(desired_payment_status(Target::Expired), Some("failed"));
        assert_eq!(desired_payment_status(Target::Invalid), Some("failed"));
    }

    #[test]
    fn invoice_and_payment_statuses_share_transition_rules() {
        // paid and confirmed are both terminal
        assert_eq!(advance_status("confirmed", "confirmed"), None);
        assert_eq!(advance_status("confirmed", "failed"), None);
        assert_eq!(advance_status("confirmed", "processing"), None);
        // a failed payment may still settle later
        assert_eq!(advance_status("failed", "confirmed"), Some("confirmed"));
        assert_eq!(advance_status("processing", "confirmed"), Some("confirmed"));
    }

    // --- value helpers ----------------------------------------------------

    #[test]
    fn payment_method_ids_map_to_rails() {
        assert_eq!(method_from_payment_method_id("BTC-LN"), "lightning");
        assert_eq!(method_from_payment_method_id("BTC-Lightning"), "lightning");
        assert_eq!(method_from_payment_method_id("lightning"), "lightning");
        assert_eq!(method_from_payment_method_id("BTC"), "bitcoin");
        assert_eq!(method_from_payment_method_id("BTC-Chain"), "bitcoin");
        assert_eq!(method_from_payment_method_id("weird"), "bitcoin");
    }

    #[test]
    fn payment_ids_are_sanitised_before_storage() {
        assert_eq!(sanitize_txid("a1b2c3").as_deref(), Some("a1b2c3"));
        assert_eq!(
            sanitize_txid("btc:txid-1_2").as_deref(),
            Some("btc:txid-1_2")
        );
        assert_eq!(sanitize_txid(""), None);
        assert_eq!(sanitize_txid("has space"), None);
        assert_eq!(sanitize_txid("bad'\"chars"), None);
        assert_eq!(sanitize_txid(&"x".repeat(129)), None);
    }

    #[test]
    fn decimal_amounts_compare_by_value() {
        assert!(decimals_equal("10.00", "10"));
        assert!(decimals_equal("10.00", "10.0000"));
        assert!(decimals_equal("0.1", "0.10"));
        assert!(decimals_equal("0", "0.00"));
        assert!(decimals_equal("1000.00", "1000.0"));

        assert!(!decimals_equal("10.01", "10.0"));
        assert!(!decimals_equal("1", "10"));
        assert!(!decimals_equal("", "0"));
        assert!(!decimals_equal("10x", "10"));
        assert!(!decimals_equal("-1", "-1.0"));
        assert!(!decimals_equal("1e2", "100"));
    }

    // --- outcome reporting ------------------------------------------------

    #[test]
    fn outcomes_render_without_leaking_internal_details() {
        let outcome = Outcome::Applied("paid");
        assert_eq!(outcome.status(), "applied");
        assert_eq!(outcome.action(), Some("paid"));
        assert_eq!(outcome.reason(), None);

        let outcome = Outcome::Ignored("no local invoice matches this provider invoice".into());
        assert_eq!(outcome.status(), "ignored");
        assert_eq!(outcome.action(), None);
        assert!(outcome.reason().is_some());

        assert_eq!(Outcome::Unchanged.status(), "unchanged");
    }
}
