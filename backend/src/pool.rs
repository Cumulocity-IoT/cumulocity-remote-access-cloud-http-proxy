//! Connection pool keyed by `tenant/user/device/config/secure`, replacing `rca-server-store.ts`.
//! Each pooled entry is a live HTTP/1 `SendRequest` over a CRA tunnel; idle connections are
//! reused for subsequent non-websocket requests. Websocket requests always open a fresh tunnel
//! and are never pooled (matching the original store semantics).

use std::collections::HashMap;
use std::sync::Mutex;

use hyper::client::conn::http1::SendRequest;

use crate::body::ProxyBody;

/// Result of trying to check out a pooled connection — distinguishes "needed a new tunnel because
/// the pool was empty" (concurrency) from "pooled connections had been closed" (upstream churn).
pub enum Checkout {
    /// A live idle connection was reused.
    Reused(SendRequest<ProxyBody>),
    /// No idle connection was available (all in use, or none pooled yet).
    Empty,
    /// Idle connections existed but had all closed; `usize` is how many were discarded.
    Closed(usize),
}

#[derive(Default)]
pub struct Pool {
    idle: Mutex<HashMap<String, Vec<SendRequest<ProxyBody>>>>,
}

impl Pool {
    pub fn new() -> Self {
        Pool::default()
    }

    /// Take a live idle connection for the key, discarding any that have closed.
    pub fn take(&self, key: &str) -> Checkout {
        let mut idle = self.idle.lock().unwrap();
        let Some(list) = idle.get_mut(key) else {
            return Checkout::Empty;
        };
        let mut discarded = 0usize;
        while let Some(sender) = list.pop() {
            if !sender.is_closed() {
                return Checkout::Reused(sender);
            }
            discarded += 1;
        }
        if discarded > 0 {
            Checkout::Closed(discarded)
        } else {
            Checkout::Empty
        }
    }

    /// Return a connection to the pool, unless it has already closed.
    pub fn put(&self, key: String, sender: SendRequest<ProxyBody>) {
        if sender.is_closed() {
            return;
        }
        let mut idle = self.idle.lock().unwrap();
        idle.entry(key).or_default().push(sender);
    }

    /// Total number of idle pooled connections (used by `/health`).
    pub fn idle_count(&self) -> usize {
        let idle = self.idle.lock().unwrap();
        idle.values().map(|v| v.len()).sum()
    }
}
