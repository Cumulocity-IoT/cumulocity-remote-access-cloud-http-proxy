//! Shared data structures. Port of `model.ts` plus the Cumulocity REST response shapes that
//! `@c8y/client` used to deserialise implicitly.

use serde::Deserialize;

/// A Cloud Remote Access configuration of a device. Mirrors `RCAConfig` from `model.ts`. Only
/// `id` is read (for debug logging); the other fields are kept to document the API shape.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct RcaConfig {
    pub id: String,
    pub name: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<serde_json::Value>,
    pub protocol: Option<String>,
}

/// One microservice subscription as returned by `/application/currentApplication/subscriptions`.
#[derive(Debug, Clone, Deserialize)]
pub struct Subscription {
    pub tenant: String,
    pub name: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct SubscriptionsResponse {
    #[serde(default)]
    pub users: Vec<Subscription>,
}

/// A single tenant option value (`/tenant/options/{category}/{key}`).
#[derive(Debug, Deserialize)]
pub struct TenantOption {
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}
