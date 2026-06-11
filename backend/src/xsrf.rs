//! Periodically disables XSRF-token validation on every subscribed tenant. Port of
//! `disableXSRFTokenValidation` plus its 5-minute `CronJob` from `index.ts`.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use crate::c8y::C8yClient;

const CATEGORY: &str = "jwt";
const KEY: &str = "xsrf-validation.enabled";

/// Tenants we have already confirmed disabled, to avoid repeated writes. Mirrors the original
/// `tenantIdsWhereXSRFTokenValidationHasBeenDisabled` array.
static DISABLED_TENANTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn already_disabled(tenant: &str) -> bool {
    let guard = DISABLED_TENANTS.lock().unwrap();
    guard.as_ref().map(|s| s.contains(tenant)).unwrap_or(false)
}

fn mark_disabled(tenant: &str) {
    let mut guard = DISABLED_TENANTS.lock().unwrap();
    guard
        .get_or_insert_with(HashSet::new)
        .insert(tenant.to_string());
}

/// Run the reconcile once across all subscribed tenants.
pub async fn disable_xsrf_token_validation(client: &C8yClient) {
    let subscriptions = match client.get_subscriptions().await {
        Ok(subs) => subs,
        Err(e) => {
            tracing::error!(error = %e, "Failed to get subscriptions");
            return;
        }
    };

    for subscription in subscriptions {
        let tenant = subscription.tenant.clone();

        if already_disabled(&tenant) {
            tracing::debug!(tenant = %tenant, "XSRF token validation already disabled for tenant");
            continue;
        }

        tracing::debug!(tenant = %tenant, "Disabling XSRF token validation for tenant");

        // If the option already reads "false", record it and move on.
        match client.get_tenant_option(&subscription, CATEGORY, KEY).await {
            Ok(Some(value)) => {
                let is_false = value.as_str() == Some("false") || value.as_bool() == Some(false);
                if is_false {
                    tracing::info!(tenant = %tenant, "XSRF token validation already disabled for tenant");
                    mark_disabled(&tenant);
                    continue;
                }
            }
            Ok(None) => { /* option does not exist yet — fall through to set it */ }
            Err(_) => { /* assume the option does not exist yet */ }
        }

        match client
            .update_tenant_option(&subscription, CATEGORY, KEY, "false")
            .await
        {
            Ok(()) => {
                tracing::info!(tenant = %tenant, "Disabled XSRF token validation for tenant");
                mark_disabled(&tenant);
            }
            Err(e) => {
                tracing::warn!(tenant = %tenant, error = %e, "Failed to disable XSRF token validation for tenant");
            }
        }
    }
}

/// Spawn the recurring 5-minute reconcile loop. Runs once immediately (`runOnInit: true`).
pub fn spawn(client: C8yClient) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            disable_xsrf_token_validation(&client).await;
        }
    });
}
