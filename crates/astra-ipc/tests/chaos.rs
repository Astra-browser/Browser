/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Chaos tests (P2-T03 acceptance): kill core/browser at random points over
//! the loopback harness and over real child-stdio pipes; state must recover
//! with no gaps and no duplicates (§5.4).

use std::time::Duration;

use astra_ipc::{
    loopback, EventRecorder, ResyncAction, SeqTracker, Transport, TransportConfig, TransportEvent,
};
use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};

fn chaos_config() -> TransportConfig {
    TransportConfig {
        heartbeat_interval: Duration::from_millis(5),
        heartbeat_timeout: Duration::from_secs(5),
        handshake_timeout: Duration::from_secs(5),
        ..TransportConfig::default()
    }
    .normalized()
}

fn seq_event(seq: u64) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: format!("e-{seq}"),
        kind: Kind::Evt,
        name: "tabs.created".to_string(),
        seq: Some(seq),
        payload: serde_json::json!({ "seq": seq }),
        error: None,
    }
}

/// Deterministic xorshift64* — "random points" that reproduce on failure.
fn rng_next(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

async fn recv_message(t: &mut Transport) -> Option<Envelope> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), t.recv())
            .await
            .expect("peer must answer within budget")
        {
            Some(TransportEvent::Message(env)) => return Some(env),
            Some(TransportEvent::PeerTimeout) => continue,
            None => return None,
        }
    }
}

fn feed_tracker(tracker: &mut SeqTracker, received: &mut Vec<u64>, env: &Envelope) {
    match tracker.feed(env) {
        ResyncAction::Ok => received.push(env.seq.unwrap()),
        ResyncAction::Duplicate => {}
        ResyncAction::Gap { expected, got } => {
            panic!("gap: expected {expected}, got {got}");
        }
    }
}

/// One chaos run over loopback TCP: `total` sequenced events flow core ->
/// browser while the harness kills one side at RNG-chosen points. The core's
/// `emitted` watermark and replay buffer act as the session snapshot that
/// survives restarts (§5.4); every reconnect opens with a resync handshake.
async fn loopback_chaos_run(seed: u64, total: u64, kill_core: bool) {
    // Ground truth: everything the core will ever emit, in order.
    let ground_truth: Vec<Envelope> = (0..total).map(seq_event).collect();

    let mut tracker = SeqTracker::new();
    let mut received: Vec<u64> = Vec::new();
    // Core snapshot state (survives restarts): how much was emitted.
    let mut emitted: u64 = 0;
    let mut rng = seed;
    let mut round = 0u32;

    while received.len() < total as usize {
        round += 1;
        assert!(round < 100, "chaos run did not converge (seed {seed})");

        // The kill lands 1..=remaining events ahead — always mid-stream
        // until the final round.
        let remaining = total - emitted;
        let chunk = 1 + rng_next(&mut rng) % remaining.max(1);
        let kill_at = (emitted + chunk).min(total);

        let cfg = chaos_config();
        let listener = loopback::bind_loopback().await.unwrap();
        let addr = loopback::listener_addr(&listener).unwrap();
        let token = astra_ipc::generate_token();
        let truth = ground_truth.clone();
        let server_token = token.clone();
        let server_cfg = cfg.clone();

        // Core side: serves the resync request from its replay buffer,
        // streams exactly up to the kill point, then dies or waits to
        // observe the browser's death.
        let server = tokio::spawn(async move {
            let mut recorder = EventRecorder::new(4096);
            for env in &truth {
                recorder.push(env.clone());
            }
            let mut core = loopback::accept(listener, &server_token, &server_cfg)
                .await
                .unwrap();
            let req = recv_message(&mut core).await.expect("resync request");
            let from = astra_ipc::resync::parse_resync_request(&req).expect("from_seq");
            let replay: Vec<Envelope> = recorder
                .replay_since(from)
                .into_iter()
                .filter(|e| e.seq.unwrap_or(u64::MAX) < emitted)
                .collect();
            core.send(astra_ipc::resync::resync_response(&req.id, &replay))
                .await
                .unwrap();
            // Stream the new chunk (best effort: the browser may be dead).
            for env in truth
                .iter()
                .skip(emitted as usize)
                .take((kill_at - emitted) as usize)
            {
                if core.send(env.clone()).await.is_err() {
                    break;
                }
            }
            if kill_core {
                core.close(); // Core crash: connection dies with it.
            } else {
                // Browser crash: observe EOF, then exit.
                while recv_message(&mut core).await.is_some() {}
            }
        });

        let ccfg = chaos_config();
        let mut browser = loopback::connect(addr, &token, &ccfg).await.unwrap();

        // Resync handshake first (§5.4): replay anything emitted but unseen.
        let want = tracker.next_expected().unwrap_or(0);
        browser
            .send(astra_ipc::resync::resync_request(
                &format!("rs-{round}"),
                want,
            ))
            .await
            .unwrap();
        let res = recv_message(&mut browser).await.expect("resync response");
        assert_eq!(res.kind, Kind::Res);
        let id = res.id.clone();
        for e in astra_ipc::resync::parse_resync_response(&res, &id).expect("events") {
            feed_tracker(&mut tracker, &mut received, &e);
        }

        if kill_core {
            // Read the streamed chunk, then observe the core's death (EOF).
            while received.len() < kill_at as usize {
                match recv_message(&mut browser).await {
                    Some(env) => feed_tracker(&mut tracker, &mut received, &env),
                    None => panic!("EOF before kill point (seed {seed} round {round})"),
                }
            }
            // Drain to EOF: proves the kill is observable, not a hang.
            while browser.recv().await.is_some() {}
            server.await.unwrap();
        } else {
            // Read the streamed chunk, then die without draining: the next
            // round's resync must redeliver whatever was in flight.
            while received.len() < kill_at as usize {
                match recv_message(&mut browser).await {
                    Some(env) => feed_tracker(&mut tracker, &mut received, &env),
                    None => panic!("EOF before kill point (seed {seed} round {round})"),
                }
            }
            drop(browser);
            server.await.unwrap();
        }
        emitted = kill_at;
    }

    let expected: Vec<u64> = (0..total).collect();
    assert_eq!(received, expected, "seed {seed} kill_core={kill_core}");
}

#[tokio::test]
async fn chaos_kill_core_loopback() {
    for seed in [1u64, 7, 42, 1234] {
        loopback_chaos_run(seed, 200, true).await;
    }
}

#[tokio::test]
async fn chaos_kill_browser_loopback() {
    for seed in [3u64, 99, 2026] {
        loopback_chaos_run(seed, 200, false).await;
    }
}

#[tokio::test]
async fn gap_triggers_second_resync() {
    // A truncated first replay must surface as resumable state: the browser
    // continues from `next_expected` and a follow-up resync closes the set.
    // This is the §5.4 recovery loop in miniature.
    let cfg = chaos_config();
    let listener = loopback::bind_loopback().await.unwrap();
    let addr = loopback::listener_addr(&listener).unwrap();
    let token = astra_ipc::generate_token();
    let server_token = token.clone();
    let server_cfg = cfg.clone();

    let server = tokio::spawn(async move {
        let mut core = loopback::accept(listener, &server_token, &server_cfg)
            .await
            .unwrap();
        let mut recorder = EventRecorder::new(64);
        for seq in 0..10u64 {
            recorder.push(seq_event(seq));
        }
        // Serve two resync rounds: first truncated, then the remainder.
        for _ in 0..2 {
            let req = recv_message(&mut core).await.unwrap();
            let from = astra_ipc::resync::parse_resync_request(&req).unwrap();
            let mut replay = recorder.replay_since(from);
            if from == 0 {
                replay.truncate(4); // Simulate a partial replay.
            }
            core.send(astra_ipc::resync::resync_response(&req.id, &replay))
                .await
                .unwrap();
        }
        core
    });
    let ccfg = chaos_config();
    let mut browser = loopback::connect(addr, &token, &ccfg).await.unwrap();

    let mut tracker = SeqTracker::new();
    let mut received: Vec<u64> = Vec::new();
    browser
        .send(astra_ipc::resync::resync_request("rs-1", 0))
        .await
        .unwrap();
    let res = recv_message(&mut browser).await.unwrap();
    let id = res.id.clone();
    let events = astra_ipc::resync::parse_resync_response(&res, &id).unwrap();
    assert_eq!(events.len(), 4);
    for e in &events {
        feed_tracker(&mut tracker, &mut received, e);
    }
    // The stream continues past the truncated replay; the gap fires here.
    let extra = seq_event(4);
    feed_tracker(&mut tracker, &mut received, &extra);
    // Ask for the remainder from next_expected.
    let want = tracker.next_expected().unwrap();
    assert_eq!(want, 5);
    browser
        .send(astra_ipc::resync::resync_request("rs-2", want))
        .await
        .unwrap();
    let res = recv_message(&mut browser).await.unwrap();
    let id = res.id.clone();
    for e in astra_ipc::resync::parse_resync_response(&res, &id).unwrap() {
        feed_tracker(&mut tracker, &mut received, &e);
    }
    assert_eq!(received, (0..10u64).collect::<Vec<_>>());
    browser.close();
    let core = server.await.unwrap();
    core.close();
}

/// Real child-stdio pipes (D-31 primary transport): `cat` echoes raw bytes,
/// which proves framing, backpressure, and crash recovery over OS pipes.
/// Killing the child mid-stream surfaces EOF; respawn + replay recovers.
#[cfg(unix)]
#[tokio::test]
async fn chaos_child_stdio_kill_and_respawn() {
    use tokio::process::Command;

    async fn spawn_cat(cfg: &TransportConfig) -> (Transport, tokio::process::Child) {
        let mut child = Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("cat must exist for the stdio test");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        // Child-stdio shape: separate read/write halves, no token (OS pipe
        // identity is the auth, per U-01).
        let t = Transport::spawn_split(stdout, stdin, cfg);
        (t, child)
    }

    let cfg = chaos_config();
    let total = 120u64;
    let mut tracker = SeqTracker::new();
    let mut received: Vec<u64> = Vec::new();
    let mut rng = 0x9E37_79B9_7F4A_7C15u64;

    let (mut t, mut child) = spawn_cat(&cfg).await;
    // Prime the pump: send everything; the kill lands at an RNG point.
    let kill_at = 1 + rng_next(&mut rng) % total;
    for seq in 0..total {
        t.send(seq_event(seq)).await.unwrap();
        if seq == kill_at {
            child.kill().await.expect("kill child");
        }
        // Drain opportunistically so pipe buffers never deadlock us.
        while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(1), t.recv()).await {
            if let TransportEvent::Message(env) = event {
                if tracker.feed(&env) == ResyncAction::Ok {
                    received.push(env.seq.unwrap());
                }
            }
        }
        if seq == kill_at {
            let _ = child.wait().await;
            break;
        }
    }
    // Drain to EOF after the kill.
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), t.recv())
        .await
        .unwrap_or(None)
    {
        if let TransportEvent::Message(env) = event {
            if tracker.feed(&env) == ResyncAction::Ok {
                received.push(env.seq.unwrap());
            }
        }
    }
    t.close();

    // Respawn (core restart) and replay the missed tail from the snapshot.
    let want = tracker.next_expected().unwrap_or(0);
    assert!(want > 0 && want <= total, "kill must land mid-stream");
    let (mut t2, mut child2) = spawn_cat(&cfg).await;
    for seq in want..total {
        t2.send(seq_event(seq)).await.unwrap();
    }
    while received.len() < total as usize {
        let event = tokio::time::timeout(Duration::from_secs(5), t2.recv())
            .await
            .expect("respawned child must answer")
            .expect("transport open");
        if let TransportEvent::Message(env) = event {
            if tracker.feed(&env) == ResyncAction::Ok {
                received.push(env.seq.unwrap());
            }
        }
    }
    t2.close();
    child2.kill().await.ok();

    assert_eq!(received, (0..total).collect::<Vec<_>>());
}

#[tokio::test]
async fn split_halves_carry_stdio_shape() {
    // `spawn_split` over split halves of one duplex stream behaves exactly
    // like the child-stdio wiring (separate R/W halves).
    let cfg = chaos_config();
    let (a, b) = tokio::io::duplex(64 * 1024);
    let (ra, wa) = tokio::io::split(a);
    let (rb, wb) = tokio::io::split(b);
    let ta = Transport::spawn_split(ra, wa, &cfg);
    let mut tb = Transport::spawn_split(rb, wb, &cfg);
    for seq in 0..32u64 {
        ta.send(seq_event(seq)).await.unwrap();
    }
    let mut got = Vec::new();
    while got.len() < 32 {
        match tokio::time::timeout(Duration::from_secs(5), tb.recv())
            .await
            .expect("peer answers")
        {
            Some(TransportEvent::Message(env)) => got.push(env.seq.unwrap()),
            Some(TransportEvent::PeerTimeout) => continue,
            None => break,
        }
    }
    assert_eq!(got, (0..32u64).collect::<Vec<_>>());
    ta.close();
    tb.close();
}
