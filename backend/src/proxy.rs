//! Proxies a single request to a device through the CRA tunnel. Equivalent to the per-route
//! handlers in `index.ts` (`getTarget` + `http-proxy` `web`/`ws`), but instead of a local TCP
//! listener it runs a `hyper` HTTP/1 client directly over the tunnel byte stream.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt};
use hyper::body::Incoming;
use hyper::client::conn::http1 as client_http1;
use hyper::header::{HeaderName, HeaderValue, CONNECTION, HOST};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

use crate::body::{empty_body, full_body, ProxyBody, ReturnBody};
use crate::c8y::C8yClient;
use crate::connection_details::ConnectionDetails;
use crate::header_adjustment;
use crate::pool::{Checkout, Pool};
use crate::rewrite::{self, RewriteOptions};
use crate::statistics::{self, STATISTICS};
use crate::{tls, tunnel};

/// Hop-by-hop headers that must not be forwarded to the device on a normal request.
const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
];

/// Entry point used by the router. Never returns an error to the caller; failures are logged and
/// turned into a `500`, matching the original try/catch behaviour.
pub async fn handle(
    pool: Arc<Pool>,
    c8y: Arc<C8yClient>,
    req: Request<Incoming>,
    device_id: String,
    config_id: String,
    forward_path: String,
    target_secure: bool,
) -> Response<ProxyBody> {
    match try_handle(pool, c8y, req, device_id, config_id, forward_path, target_secure).await {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!(error = %e, "catch block");
            status_response(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn try_handle(
    pool: Arc<Pool>,
    c8y: Arc<C8yClient>,
    req: Request<Incoming>,
    device_id: String,
    config_id: String,
    forward_path: String,
    target_secure: bool,
) -> anyhow::Result<Response<ProxyBody>> {
    let custom_host = header_adjustment::custom_host(req.headers(), &device_id, &config_id);
    let details = ConnectionDetails::extract(device_id.clone(), config_id.clone(), req.headers());

    statistics::inc(&STATISTICS.total_number_of_requests);

    // The host the device's server expects: a configured custom host wins, otherwise the
    // connection's configured hostname[:port] from its remote-access config, otherwise
    // "localhost". This drives both the `Host` header and (its hostname part) the TLS SNI on the
    // `/s` route, so servers that route by SNI/Host (e.g. behind Traefik) reach the right backend.
    let target_host = match custom_host {
        Some(host) => host,
        None => c8y
            .resolve_host(&details.original_headers, &device_id, &config_id)
            .await
            .unwrap_or_else(|| "localhost".to_string()),
    };
    let sni = host_without_port(&target_host).to_string();

    // NOTE: the original computes rewrite options with `secure = true` for BOTH routes; we
    // replicate that to preserve cookie/redirect path behaviour.
    let rewrite_opts = RewriteOptions::build(req.headers(), &device_id, &config_id, true);

    if details.is_websocket {
        return proxy_websocket(req, &details, &target_host, &sni, target_secure, &forward_path)
            .await;
    }

    proxy_http(
        pool,
        req,
        &details,
        &target_host,
        &sni,
        target_secure,
        &forward_path,
        rewrite_opts,
    )
    .await
}

/// Strip a trailing `:port` from a host, leaving just the hostname for use as the TLS SNI.
/// Leaves IPv6 literals and bare hosts untouched (only strips when the suffix is numeric).
fn host_without_port(host: &str) -> &str {
    if let Some((name, port)) = host.rsplit_once(':') {
        if !name.is_empty() && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
            return name;
        }
    }
    host
}

async fn proxy_http(
    pool: Arc<Pool>,
    req: Request<Incoming>,
    details: &ConnectionDetails,
    target_host: &str,
    sni: &str,
    target_secure: bool,
    forward_path: &str,
    rewrite_opts: RewriteOptions,
) -> anyhow::Result<Response<ProxyBody>> {
    let key = format!("{}|{}", details.pool_key(), target_secure);

    let mut sender = match pool.take(&key) {
        Checkout::Reused(s) => s,
        Checkout::Empty => {
            tracing::debug!(key = %key, "No idle pooled connection; opening a new tunnel");
            new_connection(details, target_secure, sni, false).await?
        }
        Checkout::Closed(discarded) => {
            // The upstream closed the pooled keep-alive connection(s); we have to re-open. Logged
            // at INFO because frequent occurrences here explain a higher-than-expected tunnel count.
            tracing::info!(key = %key, discarded, "Pooled connection(s) had closed; opening a new tunnel");
            new_connection(details, target_secure, sni, false).await?
        }
    };
    std::future::poll_fn(|cx| sender.poll_ready(cx)).await?;

    let method = req.method().clone();
    let device_req = build_device_request(req, details, target_host, forward_path, false)?;
    let mut resp = sender.send_request(device_req).await?;

    let status = resp.status();
    // Log the host/SNI we sent and the device server's own status, so a 404 originating from the
    // device (or its reverse proxy) is obvious and the resolved Host/SNI can be verified.
    tracing::info!(
        method = %method,
        secure = target_secure,
        host = %target_host,
        sni = %sni,
        forward_path = %forward_path,
        upstream_status = status.as_u16(),
        "Proxied request"
    );
    rewrite::apply(resp.headers_mut(), status, &rewrite_opts);

    let (parts, body) = resp.into_parts();
    let return_body = ReturnBody::new(body, key, sender, pool.clone());
    Ok(Response::from_parts(parts, BoxBody::new(return_body)))
}

async fn proxy_websocket(
    mut req: Request<Incoming>,
    details: &ConnectionDetails,
    target_host: &str,
    sni: &str,
    target_secure: bool,
    forward_path: &str,
) -> anyhow::Result<Response<ProxyBody>> {
    // Capture the (eventual) client-side upgraded IO. `upgrade::on` only extracts the pending
    // upgrade from the request extensions, leaving the request usable for forwarding.
    let client_upgrade = hyper::upgrade::on(&mut req);

    let mut sender = new_connection(details, target_secure, sni, true).await?;
    std::future::poll_fn(|cx| sender.poll_ready(cx)).await?;

    // Forward the request, preserving the websocket upgrade headers.
    let device_req = build_device_request(req, details, target_host, forward_path, true)?;
    let mut device_resp = sender.send_request(device_req).await?;

    if device_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        // Device declined the upgrade; relay its response as-is (fresh, un-pooled connection).
        let (parts, body) = device_resp.into_parts();
        let boxed = body
            .map_err(|e| std::io::Error::other(e.to_string()))
            .boxed();
        return Ok(Response::from_parts(parts, boxed));
    }

    let device_upgrade = hyper::upgrade::on(&mut device_resp);
    let (parts, _body) = device_resp.into_parts();

    // Bridge raw bytes between the client and the device once both sides have upgraded.
    tokio::spawn(async move {
        match tokio::try_join!(client_upgrade, device_upgrade) {
            Ok((client_io, device_io)) => {
                statistics::inc(&STATISTICS.current_active_connections);
                let mut client = TokioIo::new(client_io);
                let mut device = TokioIo::new(device_io);
                if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut device).await {
                    tracing::debug!(error = %e, "Websocket bridge ended");
                }
                statistics::dec(&STATISTICS.current_active_connections);
            }
            Err(e) => tracing::warn!(error = %e, "Failed to upgrade websocket connection"),
        }
    });

    // Returning the 101 makes hyper upgrade the client connection and resolve `client_upgrade`.
    Ok(Response::from_parts(parts, empty_body()))
}

/// Open a new CRA tunnel, optionally wrap it in TLS (for `/s`), perform the HTTP/1 client
/// handshake, and spawn the connection driver. Returns the request sender.
async fn new_connection(
    details: &ConnectionDetails,
    secure: bool,
    sni: &str,
    with_upgrades: bool,
) -> anyhow::Result<client_http1::SendRequest<ProxyBody>> {
    let stream = tunnel::open(details).await?;
    statistics::inc(&STATISTICS.total_number_of_servers);

    if secure {
        let tls = tls::wrap(stream, sni).await?;
        spawn_connection(TokioIo::new(tls), with_upgrades).await
    } else {
        spawn_connection(TokioIo::new(stream), with_upgrades).await
    }
}

async fn spawn_connection<I>(
    io: I,
    with_upgrades: bool,
) -> anyhow::Result<client_http1::SendRequest<ProxyBody>>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (sender, conn) = client_http1::handshake::<I, ProxyBody>(io).await?;

    statistics::inc(&STATISTICS.current_active_servers);
    tokio::spawn(async move {
        let result = if with_upgrades {
            conn.with_upgrades().await
        } else {
            conn.await
        };
        if let Err(e) = result {
            tracing::debug!(error = %e, "Tunnel connection closed with error");
        }
        statistics::dec(&STATISTICS.current_active_servers);
    });

    Ok(sender)
}

/// Build the request to forward to the device: strip the route prefix, run the header
/// adjustment, and (for non-upgrade requests) drop hop-by-hop headers and set keep-alive.
fn build_device_request(
    req: Request<Incoming>,
    details: &ConnectionDetails,
    target_host: &str,
    forward_path: &str,
    is_upgrade: bool,
) -> anyhow::Result<Request<ProxyBody>> {
    let (mut parts, body) = req.into_parts();

    header_adjustment::adjust(&mut parts.headers, &details.device_id, &details.config_id);

    // Send the host the device's server expects (custom host, the connection's configured
    // hostname[:port], or "localhost"). This overrides the incoming Cumulocity Host.
    if let Ok(value) = HeaderValue::from_str(target_host) {
        parts.headers.insert(HOST, value);
    }

    if !is_upgrade {
        for name in HOP_BY_HOP {
            parts.headers.remove(name);
        }
        // Mirrors the original `headers: { connection: "keep-alive" }` proxy option.
        parts
            .headers
            .insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    }

    parts.uri = forward_path
        .parse::<hyper::Uri>()
        .unwrap_or_else(|_| hyper::Uri::from_static("/"));

    let boxed = body
        .map_err(|e| std::io::Error::other(e.to_string()))
        .boxed();
    Ok(Request::from_parts(parts, boxed))
}

pub fn status_response(status: StatusCode) -> Response<ProxyBody> {
    Response::builder()
        .status(status)
        .body(full_body(Bytes::new()))
        .expect("valid status response")
}

/// 401 with the `WWW-Authenticate` challenge, matching the Express auth gate.
pub fn unauthorized() -> Response<ProxyBody> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(
            HeaderName::from_static("www-authenticate"),
            HeaderValue::from_static("Basic realm=\"My Realm\""),
        )
        .body(empty_body())
        .expect("valid unauthorized response")
}

#[cfg(test)]
mod tests {
    use super::host_without_port;

    #[test]
    fn strips_numeric_port_for_sni() {
        assert_eq!(host_without_port("demos.cumulocity.com:443"), "demos.cumulocity.com");
        assert_eq!(host_without_port("192.168.1.5:1880"), "192.168.1.5");
    }

    #[test]
    fn keeps_bare_host() {
        assert_eq!(host_without_port("demos.cumulocity.com"), "demos.cumulocity.com");
        assert_eq!(host_without_port("localhost"), "localhost");
    }
}
