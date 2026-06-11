//! Global runtime counters. Port of `statistics.ts` (BigInt counters become `AtomicU64`).

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct Statistics {
    pub current_active_connections: AtomicU64,
    pub total_number_of_requests: AtomicU64,
    pub total_number_of_servers: AtomicU64,
    pub total_number_of_websockets: AtomicU64,
    pub current_active_servers: AtomicU64,
}

impl Statistics {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "currentActiveConnections": self.current_active_connections.load(Ordering::Relaxed),
            "totalNumberOfRequests": self.total_number_of_requests.load(Ordering::Relaxed),
            "totalNumberOfServers": self.total_number_of_servers.load(Ordering::Relaxed),
            "totalNumberOfWebSockets": self.total_number_of_websockets.load(Ordering::Relaxed),
            "currentActiveServers": self.current_active_servers.load(Ordering::Relaxed),
        })
    }
}

/// Process-wide statistics instance.
pub static STATISTICS: Statistics = Statistics {
    current_active_connections: AtomicU64::new(0),
    total_number_of_requests: AtomicU64::new(0),
    total_number_of_servers: AtomicU64::new(0),
    total_number_of_websockets: AtomicU64::new(0),
    current_active_servers: AtomicU64::new(0),
};

#[inline]
pub fn inc(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

#[inline]
pub fn dec(counter: &AtomicU64) {
    // Saturating decrement to avoid wrap-around if a close fires more than once.
    let mut cur = counter.load(Ordering::Relaxed);
    while cur > 0 {
        match counter.compare_exchange_weak(cur, cur - 1, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => cur = actual,
        }
    }
}
