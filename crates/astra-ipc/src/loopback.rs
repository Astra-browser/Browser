/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Loopback TCP harness: authenticated `127.0.0.1` transport for tests and
//! as the documented D-31 fallback when stdio is unavailable on an OS.
//!
//! Every connection opens with a token handshake in both directions (see
//! [`crate::auth`]). A wrong or missing token fails the handshake — loopback
//! is never unauthenticated (plan §5.5).

use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

use crate::{Transport, TransportConfig, TransportError, TransportResult};

/// Bind an ephemeral loopback port for one test/fallback session.
pub async fn bind_loopback() -> TransportResult<TcpListener> {
    Ok(TcpListener::bind("127.0.0.1:0").await?)
}

/// Accept one connection, exchange handshakes, and return a live [`Transport`].
///
/// Fails with [`TransportError::AuthRejected`] on token mismatch and with
/// [`TransportError::Closed`] on handshake timeout.
pub async fn accept(
    listener: TcpListener,
    expected_token: &str,
    config: &TransportConfig,
) -> TransportResult<Transport> {
    let (stream, _) = listener.accept().await?;
    accept_stream(stream, expected_token, config).await
}

/// Handshake over an already-accepted stream (same contract as [`accept`]).
pub async fn accept_stream(
    stream: TcpStream,
    expected_token: &str,
    config: &TransportConfig,
) -> TransportResult<Transport> {
    let mut stream = stream;
    handshake_exchange(&mut stream, expected_token, config).await?;
    Ok(Transport::spawn(stream, config))
}

/// Connect to a loopback listener, exchange handshakes, and return a live
/// [`Transport`].
pub async fn connect(
    addr: std::net::SocketAddr,
    token: &str,
    config: &TransportConfig,
) -> TransportResult<Transport> {
    let mut stream = timeout(config.handshake_timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| TransportError::Closed)??;
    handshake_exchange(&mut stream, token, config).await?;
    Ok(Transport::spawn(stream, config))
}

async fn handshake_exchange<S>(
    stream: &mut S,
    token: &str,
    config: &TransportConfig,
) -> TransportResult<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Send ours first, then read theirs: full duplex, so no deadlock.
    let ours = crate::handshake_envelope("hs-local", token);
    timeout(
        config.handshake_timeout,
        crate::transport::write_envelope(&mut *stream, &ours),
    )
    .await
    .map_err(|_| TransportError::Closed)??;
    let theirs = timeout(
        config.handshake_timeout,
        crate::transport::read_envelope(&mut *stream, config.max_frame_bytes),
    )
    .await
    .map_err(|_| TransportError::Closed)??;
    crate::verify_handshake(&theirs, token)?;
    Ok(())
}

/// Loopback address of a bound listener.
pub fn listener_addr(listener: &TcpListener) -> TransportResult<std::net::SocketAddr> {
    Ok(listener.local_addr()?)
}

/// Test/fast default: tight heartbeats so timeout tests run in milliseconds.
pub fn test_config() -> TransportConfig {
    TransportConfig {
        heartbeat_interval: Duration::from_millis(10),
        heartbeat_timeout: Duration::from_millis(200),
        handshake_timeout: Duration::from_secs(5),
        ..TransportConfig::default()
    }
    .normalized()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loopback_auth_round_trip() {
        let cfg = test_config();
        let listener = bind_loopback().await.unwrap();
        let addr = listener_addr(&listener).unwrap();
        let token = crate::generate_token();
        let server_token = token.clone();
        let server = tokio::spawn(async move { accept(listener, &server_token, &cfg).await });
        let cfg2 = test_config();
        let token2 = token.clone();
        let client = connect(addr, &token2, &cfg2).await.unwrap();
        let mut server = server.await.unwrap().unwrap();
        client
            .send(crate::resync::resync_request("rs-1", 0))
            .await
            .unwrap();
        let got = server.recv().await.unwrap();
        assert!(matches!(got, crate::TransportEvent::Message(_)));
        client.close();
        server.close();
    }

    #[tokio::test]
    async fn wrong_token_rejected() {
        let cfg = test_config();
        let listener = bind_loopback().await.unwrap();
        let addr = listener_addr(&listener).unwrap();
        let server_token = crate::generate_token();
        let server = tokio::spawn(async move { accept(listener, &server_token, &cfg).await });
        let cfg2 = test_config();
        let err = match connect(addr, &crate::generate_token(), &cfg2).await {
            Err(e) => e,
            Ok(_) => panic!("connect with wrong token must fail"),
        };
        assert!(matches!(err, TransportError::AuthRejected(_)));
        // Server side also fails (client's token does not match).
        let server_err = match server.await.unwrap() {
            Err(e) => e,
            Ok(_) => panic!("accept with wrong token must fail"),
        };
        assert!(matches!(server_err, TransportError::AuthRejected(_)));
    }
}
