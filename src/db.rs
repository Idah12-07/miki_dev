//! Database connection pool.

use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::MySqlPool;

use crate::config::Config;

/// Build a connection pool from configuration.
///
/// Credentials are passed as separate options rather than a formatted URL so
/// that a password containing URL metacharacters cannot break the connection
/// string, and so credentials never appear concatenated in logs.
pub async fn connect(config: &Config) -> Result<MySqlPool, sqlx::Error> {
    let db = &config.database;

    let options = MySqlConnectOptions::new()
        .host(&db.host)
        .port(db.port)
        .database(&db.name)
        .username(&db.user)
        .password(&db.password)
        .collation("utf8mb4_unicode_ci");

    MySqlPoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
}
