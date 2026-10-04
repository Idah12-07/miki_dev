//! miki-payment API entrypoint.
//!
//! Boot order: load `.env` → build config → connect pool → run migrations →
//! serve. The process refuses to start when configuration or the database is
//! unavailable, rather than failing later on the first request.

mod btcpay;
mod config;
mod db;
mod error;
mod models;
mod routes;
mod services;
mod state;

use axum::Router;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;

    if config.btcpay.set_count() > 0 && !config.btcpay.is_complete() {
        tracing::warn!("BTCPAY_* is only partially set; Bitcoin integration stays disabled");
    }

    // Build the shared BTCPay client exactly once. Never log its
    // contents: the config Debug output would contain the API key.
    let btcpay = if config.btcpay.is_complete() {
        match btcpay::BtcpayClient::new(
            config.btcpay.url.as_deref().unwrap_or_default(),
            config.btcpay.store_id.as_deref().unwrap_or_default(),
            config.btcpay.api_key.as_deref().unwrap_or_default(),
        ) {
            Ok(client) => {
                tracing::info!("btcpay client configured");
                Some(client)
            }
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "invalid BTCPay configuration; invoice creation stays disabled"
                );
                None
            }
        }
    } else {
        None
    };

    let pool = db::connect(&config).await?;
    tracing::info!("database connected");

    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("migrations applied");

    // The webhook endpoint authenticates deliveries with this secret; if
    // it is absent, the endpoint answers 503 rather than accepting
    // unverifiable state changes. The value itself is never logged.
    if config.btcpay.has_webhook_secret() {
        tracing::info!("btcpay webhook endpoint enabled (signature verification active)");
    } else {
        tracing::warn!(
            "BTCPAY_WEBHOOK_SECRET is not set; POST /api/webhooks/btcpay will answer 503"
        );
    }

    // Optional: keep the store's webhook registration in sync with the
    // environment. Failures are non-fatal — the webhook can also be
    // created in the BTCPay UI (Settings -> Webhooks).
    if let Some(url) = config.btcpay.webhook_url.as_deref() {
        if !config.btcpay.has_webhook_secret() {
            tracing::warn!(
                "BTCPAY_WEBHOOK_URL is set but BTCPAY_WEBHOOK_SECRET is not; skipping registration"
            );
        } else if let Some(client) = btcpay.as_ref() {
            match services::webhook::ensure_registered(
                client,
                url,
                config.btcpay.webhook_secret.as_deref(),
            )
            .await
            {
                Ok(()) => tracing::info!(webhook_url = url, "btcpay webhook registered"),
                Err(error) => tracing::warn!(
                    error = %error,
                    webhook_url = url,
                    "btcpay webhook registration failed; register it in the BTCPay UI instead"
                ),
            }
        }
    }

    let port = config.server_port;
    let state = state::AppState::new(pool, btcpay, config.btcpay.webhook_secret.clone());
    let app: Router = routes::router().with_state(state);

    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Resolve on Ctrl-C or SIGTERM so in-flight requests can finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
