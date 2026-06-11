//! `/health` endpoint. Port of the Express `/health` handler. The Node version reported
//! `process.memoryUsage()` and the keep-alive agent status; the closest analogues here are the
//! process RSS (read from `/proc/self/statm`) and the pool's idle-connection count.

use std::sync::Arc;

use hyper::{Response, StatusCode};

use crate::body::{full_body, ProxyBody};
use crate::pool::Pool;

pub fn health(pool: &Arc<Pool>) -> Response<ProxyBody> {
    let body = serde_json::json!({
        "status": "ok",
        "memory": memory_info(),
        "pooledConnections": pool.idle_count(),
    });
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());

    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(full_body(bytes))
        .expect("valid health response")
}

/// Resident-set size in bytes, best-effort from `/proc/self/statm`.
fn memory_info() -> serde_json::Value {
    let rss_bytes = std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).map(|v| v.to_string()))
        .and_then(|pages| pages.parse::<u64>().ok())
        .map(|pages| pages * 4096);
    serde_json::json!({ "rss": rss_bytes })
}
