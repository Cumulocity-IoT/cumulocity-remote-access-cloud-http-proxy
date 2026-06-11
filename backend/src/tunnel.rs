//! Opens the Cumulocity Cloud Remote Access (CRA) PASSTHROUGH websocket and exposes it as a
//! plain byte stream. The CRA websocket is a raw TCP tunnel to the device's port; wrapping it as
//! `AsyncRead + AsyncWrite` lets us run an HTTP client (or raw byte bridge) directly over it,
//! replacing the throwaway local TCP listener used by `rca-connection-server.ts` /
//! `connection-handler.ts`.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::{ready, Sink, Stream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::{ClientRequestBuilder, Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::config::Config;
use crate::connection_details::ConnectionDetails;
use crate::statistics::{self, STATISTICS};

/// Adapts a websocket (a `Stream` of `Message` + `Sink` of `Message`) into a byte stream.
pub struct WsByteStream<S> {
    inner: S,
    /// Bytes from a received binary frame not yet handed to the reader.
    read_remainder: Bytes,
}

impl<S> WsByteStream<S> {
    pub fn new(inner: S) -> Self {
        WsByteStream {
            inner,
            read_remainder: Bytes::new(),
        }
    }
}

fn to_io(e: WsError) -> io::Error {
    io::Error::other(e)
}

impl<S> AsyncRead for WsByteStream<S>
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if !this.read_remainder.is_empty() {
                let n = std::cmp::min(this.read_remainder.len(), buf.remaining());
                let chunk = this.read_remainder.split_to(n);
                buf.put_slice(&chunk);
                return Poll::Ready(Ok(()));
            }

            match ready!(Pin::new(&mut this.inner).poll_next(cx)) {
                Some(Ok(Message::Binary(data))) => this.read_remainder = data,
                Some(Ok(Message::Text(text))) => {
                    this.read_remainder = Bytes::copy_from_slice(text.as_bytes())
                }
                // Control frames carry no tunnel payload; keep reading.
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {
                    continue
                }
                Some(Ok(Message::Close(_))) | None => return Poll::Ready(Ok(())), // EOF
                Some(Err(e)) => return Poll::Ready(Err(to_io(e))),
            }
        }
    }
}

impl<S> AsyncWrite for WsByteStream<S>
where
    S: Sink<Message, Error = WsError> + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let mut sink = Pin::new(&mut this.inner);
        ready!(sink.as_mut().poll_ready(cx)).map_err(to_io)?;
        sink.as_mut()
            .start_send(Message::Binary(Bytes::copy_from_slice(buf)))
            .map_err(to_io)?;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_flush(cx).map_err(to_io)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_close(cx).map_err(to_io)
    }
}

/// The concrete tunnel stream type.
pub type Tunnel = WsByteStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

/// Open a fresh CRA websocket for the given connection and wrap it as a byte stream.
/// Mirrors `RCAConnectionServer.createNewWebsocket`.
pub async fn open(details: &ConnectionDetails) -> anyhow::Result<Tunnel> {
    let cfg = Config::get();
    let url = format!(
        "{}://{}/service/remoteaccess/client/{}/configurations/{}{}",
        cfg.ws_scheme(),
        cfg.c8y_host(),
        details.device_id,
        details.config_id,
        details.query_params_string,
    );

    let uri: Uri = url.parse()?;
    let mut builder = ClientRequestBuilder::new(uri).with_sub_protocol("binary");

    // Forward the original cookie/authorization so the platform authorises the CRA session.
    if let Some(cookie) = details
        .original_headers
        .get(hyper::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    {
        builder = builder.with_header("cookie", cookie.to_string());
    }
    if let Some(auth) = details
        .original_headers
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        builder = builder.with_header("authorization", auth.to_string());
    }

    let request = builder.into_client_request()?;
    let (ws_stream, _response) = connect_async(request).await?;

    statistics::inc(&STATISTICS.total_number_of_websockets);
    tracing::debug!(url = %url, "Successfully established websocket connection");

    Ok(WsByteStream::new(ws_stream))
}
