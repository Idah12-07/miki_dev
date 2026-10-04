//! BTCPay Server Greenfield API client.
//!
//! Sole owner of HTTP communication with BTCPay. Handlers never call this
//! directly — the service layer does. Endpoint paths, field names, and the
//! authentication scheme follow the official Greenfield OpenAPI contract
//! (`POST /api/v1/stores/{storeId}/invoices`, header
//! `Authorization: token {apiKey}`).
//!
//! Credentials are stored in the client but never logged: no request or
//! authorization header is ever traced, and the client deliberately does
//! not derive `Debug`.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Greenfield invoice, as returned by BTCPay (subset we depend on).
///
/// Field names are camelCase per the API contract; the crate's own types
/// use snake_case.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcpayInvoice {
    /// BTCPay's invoice id (e.g. `HMprBnL9BTXWuPvpoKBS6e`).
    pub id: String,
    /// Public checkout page where the customer pays (Lightning included).
    pub checkout_link: String,
    /// `New | Processing | Settled | Expired | Invalid`.
    pub status: String,
    /// Unix seconds. Absent only if BTCPay omits it; stored as NULL then.
    #[serde(default)]
    pub expiration_time: Option<i64>,
    /// Decimal string in major units. Used to cross-check a webhook
    /// against the locally stored order amount before marking it paid.
    #[serde(default)]
    pub amount: Option<String>,
    /// ISO 4217 code, cross-checked the same way as `amount`.
    #[serde(default)]
    pub currency: Option<String>,
}

/// Typed `CreateInvoiceRequest` body (spec: amount is a decimal *string*).
#[derive(Debug, Clone, Serialize)]
pub struct CreateInvoiceRequest {
    pub amount: String,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<InvoiceMetadata>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceMetadata {
    /// Spec: "the order ID from an external system … indexed" — used to
    /// tie the BTCPay invoice to our internal order for lookups.
    pub order_id: String,
}

/// Greenfield store webhook, as returned by BTCPay.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcpayWebhook {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// Body for creating or updating a store webhook.
///
/// `secret` is only echoed back by BTCPay on creation, never on reads —
/// which is exactly why this app keeps its own copy in the environment
/// instead of trying to fetch it later.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRequest {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub enabled: bool,
    pub automatic_redelivery: bool,
    pub authorized_events: AuthorizedEvents,
}

/// Event subscription of a store webhook.
///
/// Everything is subscribed on purpose: the handler already
/// acknowledges events it does not act on, so a future BTCPay event
/// type can never be dropped by an out-of-date allow-list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedEvents {
    pub everything: bool,
}

/// Errors surfaced by [`BtcpayClient`]. Mapped to `ApiError` by the
/// service layer, which adds request context to the logs.
#[derive(Debug, thiserror::Error)]
pub enum BtcpayError {
    #[error("transport error: {0}")]
    Transport(String),

    #[error("unauthorized (401)")]
    Unauthorized,

    #[error("forbidden (403)")]
    Forbidden,

    #[error("invoice currency {currency} rejected by provider: {detail}")]
    CurrencyUnsupported { currency: String, detail: String },

    #[error("provider rejected request ({status}): {detail}")]
    Rejected { status: u16, detail: String },

    #[error("provider server error ({status})")]
    Provider { status: u16 },

    #[error("malformed provider response: {0}")]
    InvalidResponse(String),
}

/// Async BTCPay Greenfield client. Cheap to clone; clones share one
/// connection pool (`reqwest::Client`).
#[derive(Clone)]
pub struct BtcpayClient {
    http: reqwest::Client,
    /// Normalized base URL, no trailing slash.
    base_url: String,
    store_id: String,
    api_key: String,
}

impl BtcpayClient {
    /// Build a client from configuration.
    ///
    /// Rejects malformed URLs and store ids that could break out of the
    /// URL path. The API key is validated as non-empty only — it is never
    /// echoed back in the error.
    pub fn new(base_url: &str, store_id: &str, api_key: &str) -> Result<Self, String> {
        let base_url = base_url.trim().trim_end_matches('/');
        let store_id = store_id.trim();
        let api_key = api_key.trim();

        if base_url.is_empty() || store_id.is_empty() || api_key.is_empty() {
            return Err(
                "BTCPAY_URL, BTCPAY_STORE_ID and BTCPAY_API_KEY must all be non-empty".to_string(),
            );
        }

        let url = reqwest::Url::parse(base_url).map_err(|_| "BTCPAY_URL is not a valid URL")?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("BTCPAY_URL must use http or https".to_string());
        }

        // Store ids are path segments; keep them boring so the request
        // URL can never be reshaped.
        if store_id
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        {
            return Err("BTCPAY_STORE_ID contains invalid characters".to_string());
        }

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("miki-payment/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "failed to build HTTP client")?;

        Ok(Self {
            http,
            base_url: base_url.to_string(),
            store_id: store_id.to_string(),
            api_key: api_key.to_string(),
        })
    }

    /// The Greenfield auth header value. Kept private to this module so
    /// it cannot leak into logs or responses by accident.
    fn authorization_header(&self) -> String {
        format!("token {}", self.api_key)
    }

    /// The store this client is bound to. Webhooks that claim a
    /// different store are ignored by the service layer.
    pub fn store_id(&self) -> &str {
        &self.store_id
    }

    fn invoices_url(&self) -> String {
        format!("{}/api/v1/stores/{}/invoices", self.base_url, self.store_id)
    }

    fn invoice_url(&self, invoice_id: &str) -> Result<String, BtcpayError> {
        Ok(format!(
            "{}/{}",
            self.invoices_url(),
            path_segment(invoice_id)?
        ))
    }

    fn webhooks_url(&self) -> String {
        format!("{}/api/v1/stores/{}/webhooks", self.base_url, self.store_id)
    }

    fn webhook_url(&self, webhook_id: &str) -> Result<String, BtcpayError> {
        Ok(format!(
            "{}/api/v1/webhooks/{}",
            self.base_url,
            path_segment(webhook_id)?
        ))
    }

    /// Run one Greenfield request: send, read the body, parse it on 2xx
    /// or classify the error otherwise. Every client method funnels
    /// through here so logging, timeouts and error mapping stay
    /// identical — and so no method can accidentally log the
    /// `Authorization` header (nothing ever prints the request).
    async fn send<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        currency: Option<&str>,
    ) -> Result<T, BtcpayError> {
        let response = request
            .send()
            // `without_url` drops the target URL (store id) from the
            // error message; the API key is never part of the URL.
            .await
            .map_err(|e| BtcpayError::Transport(e.without_url().to_string()))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| BtcpayError::Transport(e.without_url().to_string()))?;

        if status.is_success() {
            return serde_json::from_str(&text)
                .map_err(|e| BtcpayError::InvalidResponse(e.to_string()));
        }

        Err(classify_error(status.as_u16(), &text, currency))
    }

    /// GET one resource with the Greenfield auth header.
    async fn get_json<T: DeserializeOwned>(&self, url: String) -> Result<T, BtcpayError> {
        self.send(
            self.http
                .get(url)
                .header("Authorization", self.authorization_header()),
            None,
        )
        .await
    }

    /// Build the typed request body for invoice creation.
    fn build_request(amount: &str, currency: &str, order_number: &str) -> CreateInvoiceRequest {
        CreateInvoiceRequest {
            amount: amount.to_string(),
            currency: currency.to_string(),
            metadata: Some(InvoiceMetadata {
                order_id: order_number.to_string(),
            }),
        }
    }

    /// Create an invoice for the configured store.
    ///
    /// `amount` must already be a decimal string in major units (service
    /// layer converts minor units). `currency` is passed through exactly
    /// as given — this client performs no conversion and never invents
    /// exchange rates. If BTCPay cannot price the currency, that surfaces
    /// as [`BtcpayError::CurrencyUnsupported`].
    pub async fn create_invoice(
        &self,
        amount: &str,
        currency: &str,
        order_number: &str,
    ) -> Result<BtcpayInvoice, BtcpayError> {
        let body = Self::build_request(amount, currency, order_number);

        self.send(
            self.http
                .post(self.invoices_url())
                .header("Authorization", self.authorization_header())
                .header("Content-Type", "application/json")
                .json(&body),
            Some(currency),
        )
        .await
    }

    /// Re-read an invoice from BTCPay. This is the source of truth the
    /// webhook flow consults before any local record changes: a webhook
    /// payload on its own is never enough to mark an order paid.
    pub async fn get_invoice(&self, invoice_id: &str) -> Result<BtcpayInvoice, BtcpayError> {
        self.get_json(self.invoice_url(invoice_id)?).await
    }

    /// List the store's webhooks (`GET /api/v1/stores/{id}/webhooks`).
    pub async fn list_webhooks(&self) -> Result<Vec<BtcpayWebhook>, BtcpayError> {
        self.get_json(self.webhooks_url()).await
    }

    /// Register (or re-register) a webhook for this store.
    pub async fn create_webhook(
        &self,
        request: &WebhookRequest,
    ) -> Result<BtcpayWebhook, BtcpayError> {
        self.send(
            self.http
                .post(self.webhooks_url())
                .header("Authorization", self.authorization_header())
                .header("Content-Type", "application/json")
                .json(request),
            None,
        )
        .await
    }

    /// Update an existing webhook (`PUT /api/v1/webhooks/{id}`).
    pub async fn update_webhook(
        &self,
        webhook_id: &str,
        request: &WebhookRequest,
    ) -> Result<BtcpayWebhook, BtcpayError> {
        self.send(
            self.http
                .put(self.webhook_url(webhook_id)?)
                .header("Authorization", self.authorization_header())
                .header("Content-Type", "application/json")
                .json(request),
            None,
        )
        .await
    }
}

/// Accept only path-segment-safe ids (BTCPay invoice/webhook ids are
/// base58/hex), so an id from a parsed webhook body can never reshape
/// the request URL.
fn path_segment(id: &str) -> Result<String, BtcpayError> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(BtcpayError::InvalidResponse(format!(
            "provider returned an unusable id ({} chars)",
            id.len()
        )));
    }
    Ok(id.to_string())
}

/// Map a non-200 Greenfield response to a typed error.
///
/// 400 bodies are inspected (best effort) for currency/rate/exchange
/// wording so an unsupported invoice currency can be reported clearly
/// instead of as a generic rejection.
fn classify_error(status: u16, body: &str, currency: Option<&str>) -> BtcpayError {
    match status {
        401 => BtcpayError::Unauthorized,
        403 => BtcpayError::Forbidden,
        500..=599 => BtcpayError::Provider { status },
        _ => {
            let detail = problem_detail(body);
            match currency {
                Some(currency) if status == 400 && mentions_currency(&detail) => {
                    BtcpayError::CurrencyUnsupported {
                        currency: currency.to_string(),
                        detail,
                    }
                }
                _ => BtcpayError::Rejected { status, detail },
            }
        }
    }
}

/// Extract a human-readable message from a Greenfield
/// `ValidationProblemDetails` body without failing on unexpected shapes.
fn problem_detail(body: &str) -> String {
    #[derive(Deserialize)]
    struct ProblemDetails {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        errors: Option<std::collections::HashMap<String, Vec<String>>>,
    }

    match serde_json::from_str::<ProblemDetails>(body) {
        Ok(details) => {
            let mut parts = Vec::new();
            if let Some(message) = details.message {
                parts.push(message);
            }
            if let Some(errors) = details.errors {
                for (field, messages) in errors {
                    parts.push(format!("{field}: {}", messages.join(", ")));
                }
            }
            if parts.is_empty() {
                "unknown error".to_string()
            } else {
                parts.join("; ")
            }
        }
        // Body is not JSON (proxy page, empty, …) — keep a short snippet.
        Err(_) => {
            let snippet: String = body.chars().take(200).collect();
            if snippet.trim().is_empty() {
                "empty response body".to_string()
            } else {
                snippet
            }
        }
    }
}

fn mentions_currency(detail: &str) -> bool {
    let lowered = detail.to_lowercase();
    lowered.contains("currency")
        || lowered.contains("exchange rate")
        || lowered.contains("price source")
        || lowered.contains("rate source")
        || lowered.contains("no rate")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> BtcpayClient {
        BtcpayClient::new("https://btcpay.example/", "Store123", "key-abc").unwrap()
    }

    // --- request construction ------------------------------------------

    #[test]
    fn request_uses_decimal_string_and_order_metadata() {
        let body = BtcpayClient::build_request("10.00", "KES", "ORD-123");
        let json = serde_json::to_value(&body).unwrap();

        assert_eq!(json["amount"], "10.00");
        assert_eq!(json["currency"], "KES");
        assert_eq!(json["metadata"]["orderId"], "ORD-123");
        // spec fields are camelCase
        assert!(json.get("order_id").is_none());
        assert!(json.get("metadata").unwrap().get("order_id").is_none());
    }

    #[test]
    fn invoices_url_matches_greenfield_contract() {
        assert_eq!(
            client().invoices_url(),
            "https://btcpay.example/api/v1/stores/Store123/invoices"
        );
    }

    #[test]
    fn authorization_header_uses_token_scheme() {
        assert_eq!(client().authorization_header(), "token key-abc");
    }

    #[test]
    fn trailing_slash_is_normalized() {
        let c = BtcpayClient::new("https://btcpay.example///", "s", "k").unwrap();
        assert_eq!(
            c.invoices_url(),
            "https://btcpay.example/api/v1/stores/s/invoices"
        );
    }

    // --- configuration validation --------------------------------------

    #[test]
    fn rejects_incomplete_or_invalid_configuration() {
        assert!(BtcpayClient::new("", "s", "k").is_err());
        assert!(BtcpayClient::new("https://x", "", "k").is_err());
        assert!(BtcpayClient::new("https://x", "s", "").is_err());
        assert!(BtcpayClient::new("not a url", "s", "k").is_err());
        assert!(BtcpayClient::new("ftp://x", "s", "k").is_err());
        // store id must not escape the path segment
        assert!(BtcpayClient::new("https://x", "a/../b", "k").is_err());
        assert!(BtcpayClient::new("https://x", "a b", "k").is_err());
    }

    // --- response parsing ----------------------------------------------

    #[test]
    fn parses_success_response() {
        let raw = r#"{
            "id": "HMprBnL9BTXWuPvpoKBS6e",
            "checkoutLink": "https://btcpay.example/i/abc",
            "status": "New",
            "expirationTime": 1793450000,
            "createdTime": 1793449100,
            "amount": "10.00",
            "currency": "KES"
        }"#;
        let invoice: BtcpayInvoice = serde_json::from_str(raw).unwrap();
        assert_eq!(invoice.id, "HMprBnL9BTXWuPvpoKBS6e");
        assert_eq!(invoice.checkout_link, "https://btcpay.example/i/abc");
        assert_eq!(invoice.status, "New");
        assert_eq!(invoice.expiration_time, Some(1793450000));
    }

    #[test]
    fn missing_required_field_is_invalid_response() {
        let raw = r#"{"id": "x", "status": "New"}"#;
        assert!(serde_json::from_str::<BtcpayInvoice>(raw).is_err());
    }

    #[test]
    fn expiration_time_is_optional() {
        let raw = r#"{
            "id": "x",
            "checkoutLink": "https://btcpay.example/i/x",
            "status": "New"
        }"#;
        let invoice: BtcpayInvoice = serde_json::from_str(raw).unwrap();
        assert_eq!(invoice.expiration_time, None);
    }

    // --- error classification ------------------------------------------

    #[test]
    fn unauthorized_and_forbidden_map_exactly() {
        assert!(matches!(
            classify_error(401, "", Some("KES")),
            BtcpayError::Unauthorized
        ));
        assert!(matches!(
            classify_error(403, "", Some("KES")),
            BtcpayError::Forbidden
        ));
    }

    #[test]
    fn server_errors_map_to_provider_unavailable() {
        assert!(matches!(
            classify_error(500, "boom", Some("KES")),
            BtcpayError::Provider { status: 500 }
        ));
        assert!(matches!(
            classify_error(503, "", Some("KES")),
            BtcpayError::Provider { status: 503 }
        ));
    }

    #[test]
    fn four_hundred_mentioning_currency_is_currency_unsupported() {
        let body = r#"{"message":"The requested currency is not supported by the price source."}"#;
        match classify_error(400, body, Some("KES")) {
            BtcpayError::CurrencyUnsupported { currency, detail } => {
                assert_eq!(currency, "KES");
                assert!(detail.contains("currency"));
            }
            other => panic!("expected CurrencyUnsupported, got {other:?}"),
        }
    }

    #[test]
    fn four_hundred_with_field_errors_can_still_be_currency() {
        let body = r#"{"errors":{"currency":["Currency KES has no exchange rate."]}}"#;
        assert!(matches!(
            classify_error(400, body, Some("KES")),
            BtcpayError::CurrencyUnsupported { .. }
        ));
    }

    /// Without a currency context (invoice reads, webhook calls) a 400
    /// must never be reported as "currency unsupported".
    #[test]
    fn four_hundred_without_currency_context_is_plain_rejection() {
        let body = r#"{"message":"The requested currency is not supported."}"#;
        assert!(matches!(
            classify_error(400, body, None),
            BtcpayError::Rejected { status: 400, .. }
        ));
    }

    #[test]
    fn unrelated_four_hundred_is_plain_rejection() {
        let body = r#"{"message":"amount is required"}"#;
        match classify_error(400, body, Some("KES")) {
            BtcpayError::Rejected { status, detail } => {
                assert_eq!(status, 400);
                assert!(detail.contains("amount"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn non_json_error_body_is_truncated_not_fatal() {
        let long = format!("<html>{}</html>", "x".repeat(500));
        match classify_error(404, &long, Some("KES")) {
            BtcpayError::Rejected { status, detail } => {
                assert_eq!(status, 404);
                assert!(detail.len() <= 200);
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    // --- re-reading invoices -------------------------------------------

    #[test]
    fn invoice_urls_follow_the_greenfield_contract() {
        let c = client();
        assert_eq!(
            c.invoice_url("HMprBnL9BTXWuPvpoKBS6e").unwrap(),
            "https://btcpay.example/api/v1/stores/Store123/invoices/HMprBnL9BTXWuPvpoKBS6e"
        );
        assert_eq!(
            c.webhooks_url(),
            "https://btcpay.example/api/v1/stores/Store123/webhooks"
        );
        assert_eq!(
            c.webhook_url("wh_1").unwrap(),
            "https://btcpay.example/api/v1/webhooks/wh_1"
        );
    }

    /// Ids come from parsed provider payloads: an id that could escape
    /// the path segment is rejected instead of being spliced into a URL.
    #[test]
    fn unsafe_provider_ids_are_rejected() {
        let too_long = "x".repeat(65);
        for bad in ["", "a/b", "a b", "a?b=c", "../etc", too_long.as_str()] {
            assert!(path_segment(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(
            path_segment("HMprBnL9BTXWuPvpoKBS6e").unwrap(),
            "HMprBnL9BTXWuPvpoKBS6e"
        );
        assert_eq!(path_segment("wh_1-2").unwrap(), "wh_1-2");
    }

    #[test]
    fn store_id_is_exposed_for_webhook_checks() {
        assert_eq!(client().store_id(), "Store123");
    }

    // --- webhook registration ------------------------------------------

    #[test]
    fn webhook_request_matches_the_greenfield_contract() {
        let body = WebhookRequest {
            url: "https://shop.example/api/webhooks/btcpay".to_string(),
            secret: Some("s3cr3t".to_string()),
            enabled: true,
            automatic_redelivery: true,
            authorized_events: AuthorizedEvents { everything: true },
        };
        let json = serde_json::to_value(&body).unwrap();

        assert_eq!(json["url"], "https://shop.example/api/webhooks/btcpay");
        assert_eq!(json["secret"], "s3cr3t");
        assert_eq!(json["enabled"], true);
        assert_eq!(json["automaticRedelivery"], true);
        assert_eq!(json["authorizedEvents"]["everything"], true);
        // never leak a partial/disabled default
        assert!(json
            .get("authorizedEvents")
            .unwrap()
            .get("specificEvents")
            .is_none());
    }

    #[test]
    fn webhook_request_omits_an_absent_secret() {
        let body = WebhookRequest {
            url: "https://shop.example/hook".to_string(),
            secret: None,
            enabled: true,
            automatic_redelivery: true,
            authorized_events: AuthorizedEvents { everything: true },
        };
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("secret").is_none());
    }

    #[test]
    fn parses_webhook_response() {
        let raw = r#"{"id":"wh_1","url":"https://shop.example/hook","enabled":true}"#;
        let hook: BtcpayWebhook = serde_json::from_str(raw).unwrap();
        assert_eq!(hook.id, "wh_1");
        assert_eq!(hook.enabled, Some(true));
    }

    #[test]
    fn parses_invoice_with_optional_money_fields() {
        // GET responses always carry amount/currency; older or trimmed
        // payloads must still parse.
        let raw = r#"{"id":"x","checkoutLink":"https://b/i/x","status":"Settled"}"#;
        let inv: BtcpayInvoice = serde_json::from_str(raw).unwrap();
        assert_eq!(inv.amount, None);
        assert_eq!(inv.currency, None);

        let raw = r#"{
            "id":"x","checkoutLink":"https://b/i/x","status":"Settled",
            "amount":"10.00","currency":"KES"
        }"#;
        let inv: BtcpayInvoice = serde_json::from_str(raw).unwrap();
        assert_eq!(inv.amount.as_deref(), Some("10.00"));
        assert_eq!(inv.currency.as_deref(), Some("KES"));
    }
}
