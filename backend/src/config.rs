//! Typed access to the process environment. Mirrors the `process.env` usage spread across
//! the original `index.ts` / `connection-details.ts` / `rca-connection-server.ts`.

use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Config {
    /// Base URL of the Cumulocity platform, e.g. `https://tenant.cumulocity.com`.
    pub c8y_baseurl: String,
    /// Port the proxy HTTP server listens on.
    pub server_port: u16,
    /// Bootstrap microservice credentials (used to list subscriptions for the XSRF cron).
    pub bootstrap_tenant: Option<String>,
    pub bootstrap_user: Option<String>,
    pub bootstrap_password: Option<String>,
    /// When set, the periodic statistics logging is disabled.
    pub no_statistics: bool,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

impl Config {
    /// Load the configuration from the environment. Panics on missing/invalid required values,
    /// which is the desired fail-fast behaviour for a microservice at startup.
    fn load() -> Self {
        let c8y_baseurl = std::env::var("C8Y_BASEURL")
            .expect("C8Y_BASEURL must be set")
            .trim_end_matches('/')
            .to_string();

        let server_port = std::env::var("SERVER_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(80);

        Config {
            c8y_baseurl,
            server_port,
            bootstrap_tenant: env_opt("C8Y_BOOTSTRAP_TENANT"),
            bootstrap_user: env_opt("C8Y_BOOTSTRAP_USER"),
            bootstrap_password: env_opt("C8Y_BOOTSTRAP_PASSWORD"),
            no_statistics: env_opt("NO_STATISTICS").is_some(),
        }
    }

    /// Global, lazily-initialised configuration.
    pub fn get() -> &'static Config {
        CONFIG.get_or_init(Config::load)
    }

    /// Host (and port) portion of the base URL, used to build the CRA websocket URL.
    pub fn c8y_host(&self) -> &str {
        self.c8y_baseurl
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&self.c8y_baseurl)
    }

    /// `wss` when the base URL is https, `ws` otherwise.
    pub fn ws_scheme(&self) -> &'static str {
        if self.c8y_baseurl.starts_with("https") {
            "wss"
        } else {
            "ws"
        }
    }
}

fn env_opt(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}
