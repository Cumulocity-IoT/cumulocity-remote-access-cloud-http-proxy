//! Cumulocity "cloud-http-proxy" microservice — Rust port of the original Node.js/TypeScript
//! implementation. Proxies HTTP/WebSocket traffic through the Cloud Remote Access PASSTHROUGH
//! tunnel to a device's local HTTP server.

mod body;
mod c8y;
mod config;
mod connection_details;
mod header_adjustment;
mod health;
mod model;
mod pool;
mod proxy;
mod rewrite;
mod statistics;
mod tls;
mod tunnel;
mod xsrf;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::body::ProxyBody;
use crate::c8y::C8yClient;
use crate::config::Config;
use crate::pool::Pool;
use crate::statistics::STATISTICS;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    // All rustls users (device TLS, reqwest, the CRA websocket) share the ring provider;
    // installing it as the process default avoids a runtime panic in `ClientConfig::builder`.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = Config::get();
    let c8y = Arc::new(C8yClient::new()?);
    let pool = Arc::new(Pool::new());

    // Cron 1: disable XSRF token validation on all subscribed tenants every 5 minutes.
    xsrf::spawn((*c8y).clone());

    // Cron 2: log statistics every minute (unless disabled).
    if !cfg.no_statistics {
        spawn_statistics_logging();
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.server_port));
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(port = cfg.server_port, "start listening on port");

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                continue;
            }
        };

        let pool = pool.clone();
        let c8y = c8y.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let pool = pool.clone();
                let c8y = c8y.clone();
                async move { Ok::<_, Infallible>(route(pool, c8y, req).await) }
            });

            // No request/header timeout: long-lived websocket connections must not be dropped
            // (the Node server set `headersTimeout`/`requestTimeout` to 0).
            if let Err(e) = http1::Builder::new()
                .keep_alive(true)
                .serve_connection(io, service)
                .with_upgrades()
                .await
            {
                tracing::debug!(error = %e, "server connection error");
            }
        });
    }
}

/// Top-level request router. Mirrors the Express route registration order: `/health`, then the
/// auth gate, then the two proxy routes.
async fn route(
    pool: Arc<Pool>,
    c8y: Arc<C8yClient>,
    req: Request<Incoming>,
) -> Response<ProxyBody> {
    if req.method() == Method::GET && req.uri().path() == "/health" {
        return health::health(&pool);
    }

    if !is_authorized(&req) {
        return proxy::unauthorized();
    }

    match parse_route(req.uri()) {
        Some(route) => {
            proxy::handle(
                pool,
                c8y,
                req,
                route.device_id,
                route.config_id,
                route.forward_path,
                route.target_secure,
            )
            .await
        }
        None => proxy::status_response(StatusCode::NOT_FOUND),
    }
}

/// Express auth gate: require an `authorization` header, or an `authorization` cookie.
fn is_authorized(req: &Request<Incoming>) -> bool {
    let headers = req.headers();
    if headers.contains_key(hyper::header::AUTHORIZATION) {
        return true;
    }
    headers
        .get(hyper::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|c| c.contains("authorization"))
        .unwrap_or(false)
}

struct RouteMatch {
    target_secure: bool,
    device_id: String,
    config_id: String,
    forward_path: String,
}

/// Parse `/[s/]<device>/<config>/<rest>?<query>` into its parts, stripping the route prefix the
/// way Express `app.use("/:device/:config/")` did.
fn parse_route(uri: &Uri) -> Option<RouteMatch> {
    let path = uri.path();
    let (target_secure, after) = match path.strip_prefix("/s/") {
        Some(rest) => (true, rest),
        None => (false, path.strip_prefix('/')?),
    };

    let mut segments = after.splitn(3, '/');
    let device_id = segments.next().filter(|s| !s.is_empty())?.to_string();
    let config_id = segments.next().filter(|s| !s.is_empty())?.to_string();
    let rest = segments.next().unwrap_or("");

    let mut forward_path = if rest.is_empty() {
        "/".to_string()
    } else {
        format!("/{rest}")
    };
    if let Some(query) = uri.query() {
        forward_path.push('?');
        forward_path.push_str(query);
    }

    Some(RouteMatch {
        target_secure,
        device_id,
        config_id,
        forward_path,
    })
}

fn init_tracing() {
    let level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    // Keep dependency noise at `warn`; apply LOG_LEVEL to this crate only.
    let directive = format!("warn,cloud_http_proxy={level}");
    let filter = tracing_subscriber::EnvFilter::try_new(&directive)
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_env_filter(filter)
        .init();
}

fn spawn_statistics_logging() {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        // Skip the immediate first tick so stats are first logged after one minute.
        interval.tick().await;
        loop {
            interval.tick().await;
            tracing::info!(
                statistics = %STATISTICS.snapshot(),
                "Statistics"
            );
        }
    });
}
