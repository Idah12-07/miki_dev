//! HTTP routing.

mod health;
mod orders;
mod webhook;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(|| async { "Miki Payment API is running" }))
        .route("/health", get(health::health))
        // Inbound integration endpoint: authenticated by BTCPay's
        // signature, not by a client session, so it lives outside the
        // versioned API namespace.
        .route("/api/webhooks/btcpay", post(webhook::btcpay_webhook))
        .nest("/api/v1", v1_router())
}

fn v1_router() -> Router<AppState> {
    Router::new()
        .route("/orders", post(orders::create_order))
        .route("/orders/{id}", get(orders::get_order))
        .route("/orders/{id}/invoice", post(orders::create_invoice))
}
