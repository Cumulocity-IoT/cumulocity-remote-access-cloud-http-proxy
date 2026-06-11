//! Minimal Cumulocity REST client, replacing the handful of `@c8y/client` calls the proxy made:
//! listing microservice subscriptions, reading/updating a tenant option, and fetching a device's
//! Cloud Remote Access configurations.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};

use crate::config::Config;
use crate::model::{RcaConfig, Subscription, SubscriptionsResponse, TenantOption};

#[derive(Clone)]
pub struct C8yClient {
    http: Client,
    base_url: String,
    /// Cache of `device/config` -> default `Host` header (the device's configured `hostname:port`),
    /// so the RCA config is only fetched once per connection. Shared across clones.
    host_cache: Arc<Mutex<HashMap<String, String>>>,
}

impl C8yClient {
    pub fn new() -> anyhow::Result<Self> {
        let http = Client::builder()
            // The proxy talks to slow/unreliable device networks elsewhere; these calls are to the
            // platform itself, so a generous-but-bounded timeout is appropriate.
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        Ok(C8yClient {
            http,
            base_url: Config::get().c8y_baseurl.clone(),
            host_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Resolve the default `Host` header for a connection from its remote-access configuration
    /// (`hostname[:port]`), caching the result per `device/config`. Returns `None` when the config
    /// can't be fetched or has no hostname, in which case the caller falls back to a default.
    pub async fn resolve_host(
        &self,
        forwarded_headers: &HeaderMap,
        device_id: &str,
        config_id: &str,
    ) -> Option<String> {
        let key = format!("{device_id}/{config_id}");
        if let Some(host) = self.host_cache.lock().unwrap().get(&key).cloned() {
            return Some(host);
        }

        let configs = match self.get_rca_configs(forwarded_headers, device_id).await {
            Ok(configs) => configs,
            Err(e) => {
                tracing::warn!(error = %e, device = %device_id, "Failed to fetch RCA config for Host header; using default");
                return None;
            }
        };

        let Some(config) = configs.into_iter().find(|c| c.id == config_id) else {
            tracing::warn!(device = %device_id, config = %config_id, "RCA config not found; using default Host");
            return None;
        };
        let Some(host) = config_host(&config) else {
            tracing::warn!(device = %device_id, config = %config_id, "RCA config has no hostname; using default Host");
            return None;
        };

        tracing::info!(device = %device_id, config = %config_id, host = %host, "Resolved device Host from RCA config");
        self.host_cache.lock().unwrap().insert(key, host.clone());
        Some(host)
    }

    /// `Client.getMicroserviceSubscriptions` — list tenants this microservice is subscribed to,
    /// authenticated with the bootstrap credentials.
    pub async fn get_subscriptions(&self) -> anyhow::Result<Vec<Subscription>> {
        let cfg = Config::get();
        let (tenant, user, password) = match (
            &cfg.bootstrap_tenant,
            &cfg.bootstrap_user,
            &cfg.bootstrap_password,
        ) {
            (Some(t), Some(u), Some(p)) => (t, u, p),
            _ => anyhow::bail!("bootstrap credentials are not configured"),
        };

        let url = format!("{}/application/currentApplication/subscriptions", self.base_url);
        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, basic_auth(&format!("{tenant}/{user}"), password))
            .header(ACCEPT, "application/json")
            .send()
            .await?
            .error_for_status()?;

        let body: SubscriptionsResponse = resp.json().await?;
        Ok(body.users)
    }

    /// `client.options.tenant.detail` — read a single tenant option. Returns `None` when the
    /// option does not exist (404), matching the original's "assume it does not exist" branch.
    pub async fn get_tenant_option(
        &self,
        subscription: &Subscription,
        category: &str,
        key: &str,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        let url = format!("{}/tenant/options/{category}/{key}", self.base_url);
        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, subscription_basic_auth(subscription))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = resp.error_for_status()?;
        let option: TenantOption = resp.json().await?;
        Ok(option.value)
    }

    /// `client.options.tenant.update` — set a tenant option value.
    pub async fn update_tenant_option(
        &self,
        subscription: &Subscription,
        category: &str,
        key: &str,
        value: &str,
    ) -> anyhow::Result<()> {
        let url = format!("{}/tenant/options/{category}/{key}", self.base_url);
        self.http
            .put(&url)
            .header(AUTHORIZATION, subscription_basic_auth(subscription))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .json(&serde_json::json!({ "value": value }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Fetch the Cloud Remote Access configurations of a device, forwarding the caller's auth as
    /// the Cumulocity microservice SDK's `MicroserviceClientRequestAuth` does: the `Authorization`
    /// header and/or `Cookie`, plus the `X-XSRF-TOKEN` header (taken from the incoming header or
    /// derived from the `XSRF-TOKEN` cookie). The XSRF token is required for cookie-based (OAI
    /// Secure) auth, otherwise Cumulocity replies 401.
    pub async fn get_rca_configs(
        &self,
        forwarded_headers: &HeaderMap,
        device_id: &str,
    ) -> anyhow::Result<Vec<RcaConfig>> {
        let url = format!(
            "{}/service/remoteaccess/devices/{device_id}/configurations",
            self.base_url
        );
        let mut req = self.http.get(&url).header(ACCEPT, "application/json");
        for name in [AUTHORIZATION, reqwest::header::COOKIE] {
            if let Some(value) = forwarded_headers.get(&name) {
                req = req.header(name, value.clone());
            }
        }

        let xsrf = forwarded_headers
            .get("x-xsrf-token")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| {
                forwarded_headers
                    .get(reqwest::header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|cookie| crate::connection_details::get_cookie(cookie, "XSRF-TOKEN"))
            });
        if let Some(xsrf) = xsrf {
            req = req.header("X-XSRF-TOKEN", xsrf);
        }

        let resp = req.send().await?.error_for_status()?;
        Ok(resp.json().await?)
    }
}

fn basic_auth(user: &str, password: &str) -> HeaderValue {
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
    HeaderValue::from_str(&format!("Basic {token}")).expect("valid basic auth header")
}

fn subscription_basic_auth(sub: &Subscription) -> HeaderValue {
    basic_auth(&format!("{}/{}", sub.tenant, sub.name), &sub.password)
}

/// Build a `Host` header value (`hostname[:port]`) from a remote-access configuration. The port
/// (which may be encoded as a number or a string) is appended unless it is absent or `0`.
fn config_host(config: &RcaConfig) -> Option<String> {
    let hostname = config
        .hostname
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())?;

    let port = config
        .port
        .as_ref()
        .and_then(|p| {
            p.as_u64()
                .map(|n| n.to_string())
                .or_else(|| p.as_str().map(|s| s.trim().to_string()))
        })
        .filter(|p| !p.is_empty() && p != "0");

    Some(match port {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg(value: serde_json::Value) -> RcaConfig {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn host_with_numeric_port() {
        let c = cfg(json!({ "id": "2", "hostname": "device.local", "port": 1880 }));
        assert_eq!(config_host(&c).as_deref(), Some("device.local:1880"));
    }

    #[test]
    fn host_with_string_port() {
        let c = cfg(json!({ "id": "2", "hostname": "device.local", "port": "8443" }));
        assert_eq!(config_host(&c).as_deref(), Some("device.local:8443"));
    }

    #[test]
    fn host_without_port() {
        let c = cfg(json!({ "id": "2", "hostname": "device.local" }));
        assert_eq!(config_host(&c).as_deref(), Some("device.local"));
    }

    #[test]
    fn port_zero_is_omitted() {
        let c = cfg(json!({ "id": "2", "hostname": "device.local", "port": 0 }));
        assert_eq!(config_host(&c).as_deref(), Some("device.local"));
    }

    #[test]
    fn missing_hostname_is_none() {
        let c = cfg(json!({ "id": "2" }));
        assert_eq!(config_host(&c), None);
    }
}
