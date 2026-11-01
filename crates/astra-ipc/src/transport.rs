/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Async read/write pump over any `AsyncRead + AsyncWrite` stream.
//!
//! Framing is owned by `astra-proto`: the write pump sends
//! [`astra_proto::encode_frame`] output, and the read pump accumulates bytes
//! and decodes them with [`astra_proto::decode_frame`]. The only check done
//! here is the configured [`crate::TransportConfig::max_frame_bytes`] cap on
//! the length prefix, so tighter budgets fail before buffering.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::{TransportConfig, TransportError, TransportResult};

/// Envelope name of the periodic liveness event (`kind = evt`, no `seq`,
/// so [`crate::SeqTracker`] ignores it).
pub const HEARTBEAT_NAME: &str = "astra:transport/heartbeat";

/// What [`Transport::recv`] yields.
#[derive(Debug)]
pub enum TransportEvent {
    /// A non-heartbeat envelope from the peer.
    Message(Envelope),
    /// No frame arrived within `heartbeat_timeout`. The transport stays open;
    /// the caller decides whether to reconnect.
    PeerTimeout,
}

/// Returns true for transport-internal heartbeat envelopes.
pub fn is_heartbeat(env: &Envelope) -> bool {
    env.kind == Kind::Evt && env.name == HEARTBEAT_NAME
}

fn heartbeat_envelope() -> Envelope {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Envelope {
        v: PROTOCOL_VERSION,
        id: format!("hb-{now_ms}"),
        kind: Kind::Evt,
        name: HEARTBEAT_NAME.to_string(),
        seq: None,
        payload: serde_json::json!({ "t_ms": now_ms }),
        error: None,
    }
}

/// Write one length-prefixed JSON frame (Appendix C) to `writer`.
pub async fn write_envelope<W>(writer: &mut W, env: &Envelope) -> TransportResult<()>
where
    W: AsyncWrite + Unpin,
{
    let frame = astra_proto::encode_frame(env);
    writer.write_all(&frame).await?;
    Ok(())
}

/// Read one length-prefixed JSON frame from `reader`, enforcing `max_bytes`.
pub async fn read_envelope<R>(reader: &mut R, max_bytes: usize) -> TransportResult<Envelope>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = [0u8; 4];
    reader.read_exact(&mut prefix).await?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > max_bytes {
        return Err(TransportError::FrameTooLarge(len, max_bytes));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    let text = String::from_utf8(body).map_err(|e| TransportError::Protocol {
        code: "bad_encoding".to_string(),
        message: e.to_string(),
    })?;
    Ok(astra_proto::parse_envelope(&text)?)
}

#[derive(Debug, Default)]
struct PumpState {
    closed: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl PumpState {
    fn fail(&self, err: TransportError) {
        *self.last_error.lock().expect("last_error poisoned") = Some(err.to_string());
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// Async read/write pump over any byte stream.
///
/// Works over child stdio pipes (primary transport per D-31: spawn with
/// [`Transport::spawn_split`] over the child's stdin/stdout) and over
/// loopback TCP (tests and the D-31 fallback; see [`crate::loopback`]).
pub struct Transport {
    outbound: mpsc::Sender<Envelope>,
    inbound: mpsc::Receiver<TransportEvent>,
    last_activity: Arc<Mutex<Instant>>,
    state: Arc<PumpState>,
    shutdown: Arc<Shutdown>,
}

impl Transport {
    /// Spawn pumps over a single duplex stream (TCP, `tokio::io::duplex`).
    pub fn spawn<S>(stream: S, config: &TransportConfig) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (read, write) = tokio::io::split(stream);
        Self::spawn_split(read, write, config)
    }

    /// Spawn pumps over separate read/write halves (child stdio pipes).
    pub fn spawn_split<R, W>(read: R, write: W, config: &TransportConfig) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let cfg = config.clone().normalized();
        let (out_tx, out_rx) = mpsc::channel::<Envelope>(cfg.outbound_capacity);
        let (in_tx, in_rx) = mpsc::channel::<TransportEvent>(cfg.inbound_capacity);
        let state = Arc::new(PumpState::default());
        let shutdown = Arc::new(Shutdown::default());
        let last_activity = Arc::new(Mutex::new(Instant::now()));

        tokio::spawn(read_pump(
            read,
            in_tx.clone(),
            Arc::clone(&last_activity),
            Arc::clone(&state),
            Arc::clone(&shutdown),
            cfg.clone(),
        ));
        tokio::spawn(write_pump(
            write,
            out_rx,
            Arc::clone(&state),
            Arc::clone(&shutdown),
        ));
        tokio::spawn(heartbeat_task(
            out_tx.clone(),
            in_tx,
            Arc::clone(&last_activity),
            Arc::clone(&state),
            Arc::clone(&shutdown),
            cfg,
        ));

        Self {
            outbound: out_tx,
            inbound: in_rx,
            last_activity,
            state,
            shutdown,
        }
    }

    /// Queue an envelope for sending, waiting when the outbound queue is
    /// full (applies backpressure to the caller). Fails with
    /// [`TransportError::Closed`] once [`Transport::close`] is called.
    pub async fn send(&self, env: Envelope) -> TransportResult<()> {
        if self.shutdown.is_set() {
            return Err(TransportError::Closed);
        }
        tokio::select! {
            biased;
            () = self.shutdown.notified() => Err(TransportError::Closed),
            res = self.outbound.send(env) => res.map_err(|_| TransportError::Closed),
        }
    }

    /// Queue an envelope without waiting; fails fast with
    /// [`TransportError::Backpressure`] when the outbound queue is full.
    pub fn try_send(&self, env: Envelope) -> TransportResult<()> {
        use tokio::sync::mpsc::error::TrySendError;
        self.outbound.try_send(env).map_err(|e| match e {
            TrySendError::Full(_) => TransportError::Backpressure,
            TrySendError::Closed(_) => TransportError::Closed,
        })
    }

    /// Receive the next inbound event. Heartbeats are consumed internally
    /// (they refresh liveness) and never surface here. Returns `None` once
    /// the transport is closed (EOF, fatal error, or [`Transport::close`]).
    pub async fn recv(&mut self) -> Option<TransportEvent> {
        self.inbound.recv().await
    }

    /// Time of the last inbound frame (including heartbeats).
    pub fn last_activity(&self) -> Instant {
        *self.last_activity.lock().expect("last_activity poisoned")
    }

    /// Whether the transport has shut down (EOF, fatal error, closed).
    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::SeqCst)
            || self.shutdown.is_set()
            || self.outbound.is_closed()
    }

    /// The last fatal pump error, if any.
    pub fn last_error(&self) -> Option<String> {
        self.state
            .last_error
            .lock()
            .expect("last_error poisoned")
            .clone()
    }

    /// Shut the transport down: mail queued before the call is flushed by
    /// the write pump, then pumps exit and [`Transport::recv`] drains
    /// to `None`. Callers must stop sending first; [`Transport::send`]
    /// fails with [`TransportError::Closed`] once close is called.
    pub fn close(&self) {
        self.shutdown.shutdown();
        self.state.closed.store(true, Ordering::SeqCst);
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

/// Cooperative shutdown signal: a fast flag plus a wake-up for parked pumps.
#[derive(Debug, Default)]
struct Shutdown {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Shutdown {
    fn shutdown(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn notified(&self) {
        self.notify.notified().await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn read_pump<R>(
    mut read: R,
    inbound: mpsc::Sender<TransportEvent>,
    last_activity: Arc<Mutex<Instant>>,
    state: Arc<PumpState>,
    shutdown: Arc<Shutdown>,
    config: TransportConfig,
) where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::<u8>::new();
    let mut chunk = vec![0u8; config.read_chunk_bytes];
    loop {
        if shutdown.is_set() {
            break;
        }
        let n = tokio::select! {
            () = shutdown.notified() => break,
            res = read.read(&mut chunk) => match res {
                Ok(n) => n,
                Err(e) => {
                    state.fail(TransportError::Io(e));
                    return;
                }
            },
        };
        if n == 0 {
            // Clean EOF: the peer went away (crash or exit).
            state.closed.store(true, Ordering::SeqCst);
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        // Enforce the configured cap on the length prefix before the codec
        // sees the frame (the codec enforces its own hard limit).
        if buf.len() >= 4 {
            let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            if len > config.max_frame_bytes {
                state.fail(TransportError::FrameTooLarge(len, config.max_frame_bytes));
                break;
            }
        }
        loop {
            match astra_proto::decode_frame(&mut buf) {
                Ok(None) => break, // Need more bytes.
                Ok(Some(env)) => {
                    *last_activity.lock().expect("last_activity poisoned") = Instant::now();
                    if is_heartbeat(&env) {
                        continue;
                    }
                    if inbound.send(TransportEvent::Message(env)).await.is_err() {
                        state.closed.store(true, Ordering::SeqCst);
                        return;
                    }
                }
                Err(proto_err) => {
                    state.fail(proto_err.into());
                    return;
                }
            }
        }
    }
}

async fn write_pump<W>(
    mut write: W,
    mut outbound: mpsc::Receiver<Envelope>,
    state: Arc<PumpState>,
    shutdown: Arc<Shutdown>,
) where
    W: AsyncWrite + Unpin,
{
    async fn write_one<W>(write: &mut W, env: &Envelope, state: &PumpState) -> bool
    where
        W: AsyncWrite + Unpin,
    {
        let frame = astra_proto::encode_frame(env);
        if let Err(e) = write.write_all(&frame).await {
            state.fail(TransportError::Io(e));
            return false;
        }
        true
    }

    loop {
        if shutdown.is_set() {
            // Graceful close: flush mail queued before the call, then exit.
            // (Senders must stop before `close`; anything racing it may drop.)
            while let Ok(env) = outbound.try_recv() {
                if is_heartbeat(&env) {
                    continue;
                }
                if !write_one(&mut write, &env, &state).await {
                    return;
                }
            }
            break;
        }
        tokio::select! {
            () = shutdown.notified() => {}
            res = outbound.recv() => {
                match res {
                    Some(env) => {
                        if !write_one(&mut write, &env, &state).await {
                            break;
                        }
                    }
                    None => break, // All senders dropped.
                }
            }
        }
    }
    let _ = write.flush().await;
}

async fn heartbeat_task(
    outbound: mpsc::Sender<Envelope>,
    inbound: mpsc::Sender<TransportEvent>,
    last_activity: Arc<Mutex<Instant>>,
    state: Arc<PumpState>,
    shutdown: Arc<Shutdown>,
    config: TransportConfig,
) {
    let mut beat = tokio::time::interval(config.heartbeat_interval);
    // `interval` fires immediately on first tick; skip that burst so a
    // fresh transport does not heartbeat before any traffic.
    beat.tick().await;
    loop {
        tokio::select! {
            () = shutdown.notified() => break,
            _ = beat.tick() => {}
        }
        if shutdown.is_set() || state.closed.load(Ordering::SeqCst) {
            break;
        }
        // Liveness probe: never block the watchdog on a full queue.
        let _ = outbound.try_send(heartbeat_envelope());
        let idle = last_activity
            .lock()
            .expect("last_activity poisoned")
            .elapsed();
        if idle >= config.heartbeat_timeout {
            state.fail(TransportError::PeerTimeout(config.heartbeat_timeout));
            // Best effort: the consumer may already be gone.
            let _ = inbound.try_send(TransportEvent::PeerTimeout);
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_config() -> TransportConfig {
        TransportConfig {
            heartbeat_interval: Duration::from_millis(10),
            heartbeat_timeout: Duration::from_secs(5),
            ..TransportConfig::default()
        }
        .normalized()
    }

    fn req(id: &str) -> Envelope {
        Envelope {
            v: PROTOCOL_VERSION,
            id: id.to_string(),
            kind: Kind::Req,
            name: "tabs_navigate".to_string(),
            seq: None,
            payload: serde_json::json!({}),
            error: None,
        }
    }

    #[tokio::test]
    async fn duplex_echo_round_trip() {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let ta = Transport::spawn(a, &test_config());
        let mut tb = Transport::spawn(b, &test_config());
        ta.send(req("r-1")).await.unwrap();
        let got = tb.recv().await.unwrap();
        match got {
            TransportEvent::Message(env) => assert_eq!(env.id, "r-1"),
            TransportEvent::PeerTimeout => panic!("unexpected timeout"),
        }
        ta.close();
        tb.close();
    }

    #[tokio::test]
    async fn backpressure_try_send_fails_fast() {
        // Capacity 1: fill it while the write pump is parked on a pipe
        // nobody drains, then try_send must fail instead of waiting.
        let (a, _b) = tokio::io::duplex(8);
        let cfg = TransportConfig {
            outbound_capacity: 1,
            heartbeat_interval: Duration::from_secs(60),
            heartbeat_timeout: Duration::from_secs(600),
            ..TransportConfig::default()
        }
        .normalized();
        let t = Transport::spawn(a, &cfg);
        // The write pump races us for the single slot; loop until full.
        let mut full = false;
        for i in 0..100 {
            if t.try_send(req(&format!("r-{i}"))).is_err() {
                full = true;
                break;
            }
        }
        assert!(full, "queue never filled; pump drained too fast");
        t.close();
    }

    #[tokio::test]
    async fn oversize_frame_kills_transport() {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let cfg = TransportConfig {
            max_frame_bytes: 16,
            ..test_config()
        }
        .normalized();
        let mut ta = Transport::spawn(a, &cfg);
        let tb = Transport::spawn(b, &test_config());
        tb.send(req("big")).await.unwrap();
        // Reader sees EOF (writer side drops its sender on close is not
        // needed: the oversize frame trips the cap first).
        let mut saw_close = false;
        for _ in 0..50 {
            if ta.is_closed() {
                saw_close = true;
                break;
            }
            if ta.recv().await.is_none() {
                saw_close = true;
                break;
            }
        }
        assert!(saw_close, "oversize frame did not close transport");
        assert!(ta.last_error().is_some_and(|e| e.contains("exceeds limit")));
        tb.close();
    }

    #[tokio::test]
    async fn peer_timeout_fires_on_silence() {
        // `tb` never sends (not even heartbeats reach `ta` if we drop it
        // before its first tick...). Instead: hold only one end and never
        // write to it: the watchdog must fire.
        let (a, b) = tokio::io::duplex(64 * 1024);
        let cfg = TransportConfig {
            heartbeat_interval: Duration::from_millis(10),
            heartbeat_timeout: Duration::from_millis(50),
            ..TransportConfig::default()
        }
        .normalized();
        let mut ta = Transport::spawn(a, &cfg);
        // Keep `b` open but silent: no transport pumps on it, so no
        // heartbeats arrive at `ta`.
        let _idle = b;
        let mut timed_out = false;
        for _ in 0..100 {
            match tokio::time::timeout(Duration::from_secs(2), ta.recv()).await {
                Ok(Some(TransportEvent::PeerTimeout)) => {
                    timed_out = true;
                    break;
                }
                Ok(Some(TransportEvent::Message(_))) => continue,
                _ => break,
            }
        }
        assert!(timed_out, "watchdog never fired");
        ta.close();
    }
}
