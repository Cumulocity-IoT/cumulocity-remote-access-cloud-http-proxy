//! Response body helpers and the pooling body wrapper.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::client::conn::http1::SendRequest;

use crate::pool::Pool;

/// Unified response/forward body type used throughout the proxy.
pub type ProxyBody = BoxBody<Bytes, std::io::Error>;

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

pub fn empty_body() -> ProxyBody {
    Empty::<Bytes>::new()
        .map_err(|e: Infallible| match e {})
        .boxed()
}

pub fn full_body(bytes: impl Into<Bytes>) -> ProxyBody {
    Full::new(bytes.into())
        .map_err(|e: Infallible| match e {})
        .boxed()
}

/// Wraps an upstream response body so that, once it is fully read, the underlying HTTP/1
/// connection (a `SendRequest`) is returned to the pool for reuse. If the body is dropped before
/// completion, the connection is simply dropped (closing it), since its state is then unknown.
pub struct ReturnBody {
    inner: Incoming,
    slot: Option<(String, SendRequest<ProxyBody>, Arc<Pool>)>,
    /// Set once the upstream body has been fully received and the connection is reusable.
    completed: bool,
}

impl ReturnBody {
    pub fn new(
        inner: Incoming,
        key: String,
        sender: SendRequest<ProxyBody>,
        pool: Arc<Pool>,
    ) -> Self {
        ReturnBody {
            inner,
            slot: Some((key, sender, pool)),
            completed: false,
        }
    }

    /// Hand the connection back to the pool (idempotent — only the first call has an effect).
    fn return_to_pool(&mut self) {
        if let Some((key, sender, pool)) = self.slot.take() {
            pool.put(key, sender);
        }
    }
}

impl Body for ReturnBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            // Terminal frame observed (chunked / EOF-framed responses): reuse the connection now.
            Poll::Ready(None) => {
                this.completed = true;
                this.return_to_pool();
                Poll::Ready(None)
            }
            Poll::Ready(Some(Ok(frame))) => {
                // A `Content-Length` body reports end-of-stream right after its last data frame;
                // hyper then stops without polling the terminal `None`, so record completion here
                // and let `Drop` return the connection.
                if this.inner.is_end_stream() {
                    this.completed = true;
                }
                Poll::Ready(Some(Ok(frame)))
            }
            // On a body error the connection state is unknown — drop it instead of pooling.
            Poll::Ready(Some(Err(e))) => {
                this.slot = None;
                Poll::Ready(Some(Err(io_err(e))))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for ReturnBody {
    fn drop(&mut self) {
        // Return the connection to the pool when the upstream body was fully consumed:
        //  - `completed` is set while polling (chunked bodies, and Content-Length bodies whose
        //    `is_end_stream` flips true right after the last data frame);
        //  - `is_end_stream()` covers empty / zero-length bodies (304, 204, redirects, …) that
        //    hyper writes without ever polling, which would otherwise leak a connection per
        //    response.
        // A partially-read body (client aborted) leaves both false, so its connection closes.
        if self.completed || self.inner.is_end_stream() {
            self.return_to_pool();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::{Checkout, Pool};
    use http_body_util::BodyExt;
    use hyper::client::conn::http1;
    use hyper_util::rt::TokioIo;
    use std::pin::Pin;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    /// Minimal keep-alive HTTP/1.1 upstream: replies to every request it reads with a fixed
    /// `Content-Length` response, looping so one connection can serve multiple requests.
    async fn mock_keep_alive_upstream(mut io: DuplexStream) {
        let mut buf = [0u8; 1024];
        loop {
            match io.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let resp =
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nhello";
                    if io.write_all(resp).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    /// Reproduces the real bug: a `Content-Length` response read the way hyper reads it (stopping
    /// at the declared byte count, never polling the terminal `None`) must still return the
    /// connection to the pool, and a follow-up request must reuse it rather than dialing anew.
    #[tokio::test]
    async fn keep_alive_connection_is_pooled_and_reused() {
        let (client_io, server_io) = tokio::io::duplex(4096);
        tokio::spawn(mock_keep_alive_upstream(server_io));

        let (mut sender, conn) = http1::handshake::<_, ProxyBody>(TokioIo::new(client_io))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let pool = Arc::new(Pool::new());
        let key = "tenant/user/dev/cfg/false".to_string();

        // Request 1: send, then consume the body as hyper would for a Content-Length response.
        let req = hyper::Request::builder()
            .uri("/")
            .body(empty_body())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        let (_parts, body) = resp.into_parts();
        let mut rb = ReturnBody::new(body, key.clone(), sender, pool.clone());

        let mut data = Vec::new();
        // Pull data frames until end-of-stream is signalled, then drop WITHOUT polling `None`.
        while !rb.is_end_stream() {
            match std::future::poll_fn(|cx| Pin::new(&mut rb).poll_frame(cx)).await {
                Some(Ok(frame)) => {
                    if let Ok(d) = frame.into_data() {
                        data.extend_from_slice(&d);
                    }
                }
                _ => break,
            }
        }
        assert_eq!(&data, b"hello");
        drop(rb);

        assert_eq!(
            pool.idle_count(),
            1,
            "a fully-read keep-alive connection must be returned to the pool"
        );

        // Request 2: must reuse the pooled connection.
        let Checkout::Reused(mut reused) = pool.take(&key) else {
            panic!("a pooled connection should be available for reuse");
        };
        std::future::poll_fn(|cx| reused.poll_ready(cx)).await.unwrap();
        let req2 = hyper::Request::builder()
            .uri("/")
            .body(empty_body())
            .unwrap();
        let resp2 = reused.send_request(req2).await.unwrap();
        assert_eq!(resp2.status(), 200);
        let body2 = resp2.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body2.as_ref(), b"hello");
    }

    /// An empty / zero-length response body (which hyper may write without ever polling) must
    /// still return its connection to the pool, otherwise every 304/204/redirect burns a tunnel.
    #[tokio::test]
    async fn empty_body_connection_is_pooled() {
        let (client_io, mut server_io) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let _ = server_io.read(&mut buf).await;
            let _ = server_io
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n")
                .await;
            // Keep the connection open so it stays reusable.
            let mut tail = [0u8; 1024];
            let _ = server_io.read(&mut tail).await;
        });

        let (mut sender, conn) = http1::handshake::<_, ProxyBody>(TokioIo::new(client_io))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let pool = Arc::new(Pool::new());
        let key = "tenant/user/dev/cfg/false".to_string();

        let req = hyper::Request::builder()
            .uri("/")
            .body(empty_body())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let (_parts, body) = resp.into_parts();

        // Drop the wrapped body WITHOUT polling it, mimicking hyper not polling an empty body.
        let rb = ReturnBody::new(body, key.clone(), sender, pool.clone());
        drop(rb);

        assert_eq!(
            pool.idle_count(),
            1,
            "an empty-body response must still return its connection to the pool"
        );
    }

    /// Confirms that a `Host` header set on an origin-form (`/`) request actually reaches the
    /// upstream — i.e. hyper does not silently drop it when the request URI carries no authority.
    #[tokio::test]
    async fn host_header_is_forwarded_to_upstream() {
        let (client_io, mut server_io) = tokio::io::duplex(4096);
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();

        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            let n = server_io.read(&mut buf).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = server_io
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;
            let _ = tx.send(raw);
        });

        let (mut sender, conn) = http1::handshake::<_, ProxyBody>(TokioIo::new(client_io))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let req = hyper::Request::builder()
            .uri("/")
            .header(hyper::header::HOST, "device.example")
            .body(empty_body())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status(), 200);

        let raw = rx.await.unwrap();
        assert!(
            raw.to_lowercase().contains("host: device.example"),
            "Host header was not forwarded to the upstream; raw request was:\n{raw}"
        );
    }
}
