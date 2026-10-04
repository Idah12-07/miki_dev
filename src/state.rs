//! Application state shared by every handler.

use sqlx::MySqlPool;

use crate::btcpay::BtcpayClient;

#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    /// Built once at startup when `BTCPAY_*` is fully configured.
    /// `None` disables invoice creation (endpoint answers 503) instead
    /// of failing process boot.
    pub btcpay: Option<BtcpayClient>,
    /// Shared secret of the BTCPay webhook (`BTCPAY_WEBHOOK_SECRET`).
    /// `None` disables the webhook endpoint (503): without it no
    /// delivery can be authenticated, so none is accepted.
    pub webhook_secret: Option<String>,
}

impl AppState {
    pub fn new(
        pool: MySqlPool,
        btcpay: Option<BtcpayClient>,
        webhook_secret: Option<String>,
    ) -> Self {
        Self {
            pool,
            btcpay,
            webhook_secret,
        }
    }
}
