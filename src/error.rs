//! API error type and its HTTP mapping.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Conflict(String),

    #[error("bitcoin payments are not configured")]
    NotConfigured,

    /// The webhook endpoint cannot run: `BTCPAY_WEBHOOK_SECRET` is
    /// missing (no way to authenticate a delivery) or the BTCPay client
    /// is unavailable (no way to re-verify one).
    #[error("btcpay webhook is not configured")]
    WebhookNotConfigured,

    /// The `BTCPay-Sig` header is absent, malformed, or does not match
    /// the body. Never echoes the header or the computed digest.
    #[error("invalid webhook signature")]
    WebhookSignatureInvalid,

    #[error("payment provider does not support invoice currency {currency}")]
    ProviderCurrencyUnsupported { currency: String },

    /// Upstream BTCPay rejected our request. `0` is logged, never sent
    /// to the client.
    #[error("payment provider error")]
    PaymentProvider(String),

    /// BTCPay is unreachable or answered with a server error. `0` is
    /// logged, never sent to the client.
    #[error("payment provider unavailable")]
    ProviderUnavailable(String),

    #[error("internal server error")]
    Internal(String),

    #[error("database error")]
    Database(#[from] sqlx::Error),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::WebhookSignatureInvalid => StatusCode::UNAUTHORIZED,
            Self::NotConfigured | Self::WebhookNotConfigured | Self::ProviderUnavailable(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            Self::PaymentProvider(_) | Self::ProviderCurrencyUnsupported { .. } => {
                StatusCode::BAD_GATEWAY
            }
            Self::Internal(_) | Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn client_message(&self) -> String {
        match self {
            // Never forward SQL or internal details to the client.
            // `PaymentProvider` / `ProviderUnavailable` expose only their
            // fixed, detail-free message; the inner detail is logged above.
            Self::Internal(_) | Self::Database(_) => "internal server error".to_string(),
            other => other.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match &self {
            Self::Database(err) => tracing::error!(error = %err, "database query failed"),
            Self::Internal(detail) => tracing::error!(detail = %detail, "internal error"),
            Self::PaymentProvider(detail) => {
                tracing::error!(detail = %detail, "payment provider request failed")
            }
            Self::ProviderUnavailable(detail) => {
                tracing::error!(detail = %detail, "payment provider unavailable")
            }
            // Security-relevant, but never logged with the offending
            // header or payload: an attacker must not be able to use
            // the logs as an oracle, and probes must not be echoed.
            Self::WebhookSignatureInvalid => {
                tracing::warn!("rejected webhook delivery: signature verification failed")
            }
            Self::WebhookNotConfigured => {
                tracing::warn!("rejected webhook delivery: endpoint is not configured")
            }
            _ => {}
        }

        let body = json!({
            "error": self.client_message(),
            "code": self.status().as_u16(),
        });

        (self.status(), Json(body)).into_response()
    }
}
