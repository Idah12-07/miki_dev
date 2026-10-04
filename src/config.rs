//! Environment-driven configuration.
//!
//! Every secret and host name comes from the environment. Nothing in this
//! file contains a literal credential, and error messages name the variable
//! without echoing its value.

use std::env;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable: {0}")]
    MissingVar(&'static str),

    #[error("invalid value for environment variable {name}")]
    InvalidVar { name: &'static str },
}

/// Where the database lives, expressed without ever building a URL by
/// string concatenation (a password containing `@` or `:` stays safe).
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub host: String,
    pub port: u16,
    pub name: String,
    pub user: String,
    pub password: String,
}

/// BTCPay Server credentials. All optional: nothing talks to Bitcoin yet.
///
/// `Debug` is hand-written so that a stray `{:?}` of the config can never
/// print the API key or the webhook secret.
#[derive(Clone, Default)]
pub struct BtcpayConfig {
    pub url: Option<String>,
    pub store_id: Option<String>,
    pub api_key: Option<String>,
    /// Shared secret of the BTCPay webhook that points at this server.
    pub webhook_secret: Option<String>,
    /// Public URL of `POST /api/webhooks/btcpay`. When set (together with
    /// the secret) the webhook is registered on the store at startup.
    pub webhook_url: Option<String>,
}

impl std::fmt::Debug for BtcpayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fn shown<T>(value: &Option<T>) -> &'static str {
            if value.is_some() {
                "<set>"
            } else {
                "<unset>"
            }
        }
        f.debug_struct("BtcpayConfig")
            .field("url", &self.url)
            .field("store_id", &self.store_id)
            .field("api_key", &shown(&self.api_key))
            .field("webhook_secret", &shown(&self.webhook_secret))
            .field("webhook_url", &self.webhook_url)
            .finish()
    }
}

impl BtcpayConfig {
    /// True only when every invoice-creation credential is present.
    pub fn is_complete(&self) -> bool {
        self.url.is_some() && self.store_id.is_some() && self.api_key.is_some()
    }

    /// Number of invoice-creation variables set, used to warn about a
    /// partial configuration. The webhook variables are independent.
    pub fn set_count(&self) -> usize {
        [
            self.url.is_some(),
            self.store_id.is_some(),
            self.api_key.is_some(),
        ]
        .iter()
        .filter(|&&v| v)
        .count()
    }

    /// True when the webhook endpoint can verify signatures.
    pub fn has_webhook_secret(&self) -> bool {
        self.webhook_secret.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub server_port: u16,
    pub database: DatabaseConfig,
    pub btcpay: BtcpayConfig,
}

fn read(name: &'static str) -> Result<Option<String>, ConfigError> {
    match env::var(name) {
        Ok(v) if v.trim().is_empty() => Ok(None),
        Ok(v) => Ok(Some(v)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError::InvalidVar { name }),
    }
}

fn read_required(name: &'static str) -> Result<String, ConfigError> {
    read(name)?.ok_or(ConfigError::MissingVar(name))
}

fn read_port(name: &'static str, default: u16) -> Result<u16, ConfigError> {
    match read(name)? {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| ConfigError::InvalidVar { name }),
    }
}

/// Port the HTTP server listens on, in precedence order:
///
/// 1. `PORT` — injected by Railway and most PaaS platforms. It must win,
///    otherwise the process listens on a port nothing routes to and the
///    service never becomes reachable.
/// 2. `SERVER_PORT` — used by local runs and the Docker image.
/// 3. `3000` — final default.
///
/// A variable that is present but unparseable is an error, not a silent
/// fallback, so a typo cannot ship unnoticed.
fn read_server_port() -> Result<u16, ConfigError> {
    for name in ["PORT", "SERVER_PORT"] {
        if let Some(value) = read(name)? {
            return value.parse().map_err(|_| ConfigError::InvalidVar { name });
        }
    }
    Ok(3000)
}

impl Config {
    /// Load configuration from the process environment (and `.env`, if present).
    pub fn from_env() -> Result<Self, ConfigError> {
        let database = if let Some(url) = read("DATABASE_URL")? {
            // Split so the password never needs re-encoding into a new URL.
            parse_database_url(&url)?
        } else {
            DatabaseConfig {
                host: read("DB_HOST")?.unwrap_or_else(|| "127.0.0.1".to_string()),
                port: read_port("DB_PORT", 3306)?,
                name: read("DB_NAME")?.unwrap_or_else(|| "miki_payment".to_string()),
                user: read_required("DB_USER")?,
                password: read_required("DB_PASSWORD")?,
            }
        };

        let btcpay = BtcpayConfig {
            url: read("BTCPAY_URL")?,
            store_id: read("BTCPAY_STORE_ID")?,
            api_key: read("BTCPAY_API_KEY")?,
            webhook_secret: read("BTCPAY_WEBHOOK_SECRET")?,
            webhook_url: read("BTCPAY_WEBHOOK_URL")?,
        };

        Ok(Self {
            server_port: read_server_port()?,
            database,
            btcpay,
        })
    }
}

/// Minimal `mysql://user:pass@host:port/db` parsing without pulling in a URL
/// crate. Rejects anything that does not match the expected shape.
fn parse_database_url(url: &str) -> Result<DatabaseConfig, ConfigError> {
    let rest = url
        .strip_prefix("mysql://")
        .ok_or(ConfigError::InvalidVar {
            name: "DATABASE_URL",
        })?;

    let (authority, name) = rest.split_once('/').ok_or(ConfigError::InvalidVar {
        name: "DATABASE_URL",
    })?;
    let name = name.split('?').next().unwrap_or_default();

    let (credentials, host) = authority.rsplit_once('@').ok_or(ConfigError::InvalidVar {
        name: "DATABASE_URL",
    })?;

    let (user, password) = credentials.split_once(':').ok_or(ConfigError::InvalidVar {
        name: "DATABASE_URL",
    })?;

    let (host, port) = match host.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse().map_err(|_| ConfigError::InvalidVar {
                name: "DATABASE_URL",
            })?,
        ),
        None => (host.to_string(), 3306u16),
    };

    if user.is_empty() || name.is_empty() {
        return Err(ConfigError::InvalidVar {
            name: "DATABASE_URL",
        });
    }

    Ok(DatabaseConfig {
        host,
        port,
        name: name.to_string(),
        user: user.to_string(),
        password: password.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sets `PORT` and `SERVER_PORT` for the duration of a closure and
    /// restores their previous values (or absence) afterwards. Every case
    /// runs inside this one test so no two cases can race on the process
    /// environment.
    struct PortEnv {
        previous: [(&'static str, Option<String>); 2],
    }

    impl PortEnv {
        fn set(port: Option<&str>, server_port: Option<&str>) -> Self {
            let values = [("PORT", port), ("SERVER_PORT", server_port)];
            let mut previous = Vec::new();
            for (name, value) in values {
                previous.push((name, env::var(name).ok()));
                // SAFETY: only this test touches PORT/SERVER_PORT, and no
                // other thread in this test binary reads them.
                unsafe {
                    match value {
                        Some(v) => env::set_var(name, v),
                        None => env::remove_var(name),
                    }
                }
            }
            Self {
                previous: previous.try_into().unwrap(),
            }
        }
    }

    impl Drop for PortEnv {
        fn drop(&mut self) {
            for (name, value) in &self.previous {
                unsafe {
                    match value {
                        Some(v) => env::set_var(name, v),
                        None => env::remove_var(name),
                    }
                }
            }
        }
    }

    #[test]
    fn server_port_precedence_is_port_then_server_port_then_3000() {
        {
            let _env = PortEnv::set(Some("8080"), Some("9000"));
            assert_eq!(read_server_port().unwrap(), 8080, "PORT wins");
        }
        {
            let _env = PortEnv::set(Some("  "), Some("9000"));
            assert_eq!(
                read_server_port().unwrap(),
                9000,
                "blank PORT falls through"
            );
        }
        {
            let _env = PortEnv::set(None, Some("9000"));
            assert_eq!(
                read_server_port().unwrap(),
                9000,
                "SERVER_PORT is the fallback"
            );
        }
        {
            let _env = PortEnv::set(None, None);
            assert_eq!(read_server_port().unwrap(), 3000, "final default");
        }
        {
            let _env = PortEnv::set(Some("not-a-number"), None);
            assert!(
                matches!(
                    read_server_port(),
                    Err(ConfigError::InvalidVar { name: "PORT" })
                ),
                "an unparsable PORT is an error, not a silent fallback"
            );
        }
    }
}
