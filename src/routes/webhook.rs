//! BTCPay webhook endpoint.
//!
//! `POST /api/webhooks/btcpay` — the only route that accepts state
//! changes without a client request behind them, so it is deliberately
//! strict:
//!
//! 1. the `BTCPay-Sig` header is verified against the **raw** body
//!    before any parsing (a JSON body cannot be re-serialised and still
//!    match a byte-exact HMAC);
//! 2. the payload is parsed and validated;
//! 3. the service re-reads the invoice from BTCPay and only then writes
//!    to the database.
//!
//! Everything except a provider outage is acknowledged with `200`, so
//! BTCPay does not retry events that are duplicates or out of scope.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::services::webhook::{self, SIGNATURE_HEADER};
use crate::state::AppState;

/// Handle one BTCPay delivery.
///
/// Extractors run in order: state, headers, then the raw body (which
/// must come last because it consumes the request).
pub async fn btcpay_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    // No secret → no way to authenticate a delivery → accept none.
    let secret = state
        .webhook_secret
        .as_deref()
        .ok_or(ApiError::WebhookNotConfigured)?;

    let signature = headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok());

    if !webhook::verify_signature(secret, &body, signature) {
        return Err(ApiError::WebhookSignatureInvalid);
    }

    let event: webhook::WebhookEvent = serde_json::from_slice(&body)
        .map_err(|_| ApiError::BadRequest("malformed webhook payload".to_string()))?;
    event.validate()?;

    // Re-verification needs the provider client; without it nothing can
    // be confirmed, so nothing is applied.
    let btcpay = state
        .btcpay
        .as_ref()
        .ok_or(ApiError::WebhookNotConfigured)?;

    let outcome = webhook::process_event(&state.pool, btcpay, &event).await?;

    tracing::debug!(
        delivery_id = event.delivery_id.as_deref().unwrap_or_default(),
        original_delivery_id = event.original_delivery_id.as_deref().unwrap_or_default(),
        redelivery = event.is_redelivery,
        event_type = event.event_type.as_deref().unwrap_or_default(),
        status = outcome.status(),
        "webhook delivery handled"
    );

    let mut response = json!({ "status": outcome.status() });
    if let Some(action) = outcome.action() {
        response["action"] = json!(action);
    }
    if let Some(reason) = outcome.reason() {
        response["reason"] = json!(reason);
    }

    Ok((StatusCode::OK, Json(response)))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::Request;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
    use tower::ServiceExt;

    use crate::services::webhook::SIGNATURE_PREFIX;

    /// A pool that never connects: none of these tests reach the
    /// database, because authentication and validation run first.
    fn state_with_secret(secret: Option<&str>) -> AppState {
        let options = MySqlConnectOptions::new()
            .host("127.0.0.1")
            .port(1)
            .username("nobody")
            .password("nobody")
            .database("nobody");
        let pool = MySqlPoolOptions::new()
            .max_connections(1)
            .connect_lazy_with(options);
        AppState::new(pool, None, secret.map(str::to_string))
    }

    fn sign(secret: &str, body: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body.as_bytes());
        let digest: Vec<u8> = mac.finalize().into_bytes().to_vec();
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!("{SIGNATURE_PREFIX}{hex}")
    }

    async fn post(state: AppState, body: &str, signature: Option<&str>) -> (StatusCode, String) {
        let app = crate::routes::router().with_state(state);

        let mut request = Request::post("/api/webhooks/btcpay")
            .header("content-type", "application/json")
            .header("user-agent", "btcpay-test");
        if let Some(signature) = signature {
            request = request.header(SIGNATURE_HEADER, signature);
        }

        let response = app
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();

        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    const SECRET: &str = "test-webhook-secret";

    #[tokio::test]
    async fn missing_signature_is_rejected() {
        let (status, body) = post(
            state_with_secret(Some(SECRET)),
            r#"{"type":"InvoiceSettled"}"#,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("invalid webhook signature"));
    }

    #[tokio::test]
    async fn wrong_signature_is_rejected() {
        let body = r#"{"type":"InvoiceSettled"}"#;
        let signature = sign("some-other-secret", body);
        let (status, response) =
            post(state_with_secret(Some(SECRET)), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(response.contains("invalid webhook signature"));
    }

    /// A truncated/tampered body must fail even though the header is
    /// well-formed: the HMAC covers every byte.
    #[tokio::test]
    async fn tampered_body_is_rejected() {
        let original = r#"{"type":"InvoiceSettled"}"#;
        let signature = sign(SECRET, original);
        let tampered = r#"{"type":"InvoiceSettled","invoiceId":"x"}"#;
        let (status, _) = post(state_with_secret(Some(SECRET)), tampered, Some(&signature)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// Neither the secret nor any part of it may appear in a response.
    #[tokio::test]
    async fn error_responses_never_contain_the_secret() {
        for (body, signature) in [
            (r#"{"type":"InvoiceSettled"}"#, None),
            (
                r#"{"type":"InvoiceSettled"}"#,
                Some(sign("other", r#"{"type":"InvoiceSettled"}"#)),
            ),
        ] {
            let (status, response) =
                post(state_with_secret(Some(SECRET)), body, signature.as_deref()).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(!response.contains(SECRET), "leaked the secret: {response}");
        }
    }

    #[tokio::test]
    async fn without_a_configured_secret_the_endpoint_refuses_deliveries() {
        let body = r#"{"type":"InvoiceSettled","invoiceId":"inv1"}"#;
        let signature = sign(SECRET, body);
        let (status, response) = post(state_with_secret(None), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.contains("not configured"));
    }

    #[tokio::test]
    async fn malformed_json_is_a_bad_request_even_when_signed() {
        let body = "{not json";
        let signature = sign(SECRET, body);
        let (status, response) =
            post(state_with_secret(Some(SECRET)), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(response.contains("malformed webhook payload"));
    }

    #[tokio::test]
    async fn missing_event_type_is_a_bad_request() {
        let body = r#"{"invoiceId":"inv1"}"#;
        let signature = sign(SECRET, body);
        let (status, response) =
            post(state_with_secret(Some(SECRET)), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(response.contains("event type"));
    }

    #[tokio::test]
    async fn invoice_event_without_invoice_id_is_a_bad_request() {
        let body = r#"{"type":"InvoiceSettled"}"#;
        let signature = sign(SECRET, body);
        let (status, response) =
            post(state_with_secret(Some(SECRET)), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(response.contains("invoiceId"));
    }

    /// Everything is authenticated, but without a BTCPay client the
    /// invoice cannot be re-verified — so the delivery is refused
    /// (5xx → BTCPay retries) instead of being applied blind.
    #[tokio::test]
    async fn valid_delivery_without_a_provider_client_is_service_unavailable() {
        let body = r#"{"type":"InvoiceSettled","invoiceId":"inv1","storeId":"Store123"}"#;
        let signature = sign(SECRET, body);
        let (status, _) = post(state_with_secret(Some(SECRET)), body, Some(&signature)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }
}
