//! ZModem for enig-term: icy_net's ZModem (icy_board, Apache-2.0, by Mike
//! Krüger) compiled to wasm32, behind a push-model wasm-bindgen wrapper.
//!
//! icy_net's protocol code is async and pulls bytes from a `Connection`. Here
//! the connection is a pair of queues: JS feeds the remote's bytes in
//! (`feed`), takes ours out (`take_output`), and the protocol future is
//! polled with a no-op waker whenever something may have changed (`feed`,
//! `tick`, `provide`, `poll`). A read with nothing queued is Pending; time
//! comes from the clock JS passes to `tick`. Files go out as events
//! (`next_event`) and come in through a window the host fills on request
//! (`need_*`, `provide`), so neither direction keeps a file whole.
//!
//! The icy_net sources are compiled from build/icy_board/ (prepared by
//! scripts/prepare-icy.sh at the revision in Cargo.toml, with
//! patches/icy_board/*.patch applied); only the wrapper and the shims in
//! rt.rs are this crate's own.

#[path = "../../../build/icy_board/crates/icy_net/src/connection/mod.rs"]
pub mod connection;
pub use connection::*;
#[path = "../../../build/icy_board/crates/icy_net/src/crc.rs"]
pub mod crc;
#[path = "../../../build/icy_board/crates/icy_net/src/protocol/mod.rs"]
pub mod protocol;
pub mod rt;

use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

use async_trait::async_trait;
use thiserror::Error;
use wasm_bindgen::prelude::*;

use protocol::{OutputLogMessage, Protocol, TransferState, Zmodem};
use rt::{FileEvent, Host, HostRef, Source};

// From icy_net's lib.rs: what the compiled modules refer to as crate::Result
// and crate::NetError (the variants they use).
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Error, Debug)]
pub enum NetError {
    #[error("Operation is unsupported")]
    Unsupported,

    #[error("Connection closed")]
    ConnectionClosed,
}

static LAST_PANIC: Mutex<String> = Mutex::new(String::new());

/// Message of the last panic (a panic aborts the instance; JS reads this, then
/// starts a new one).
#[wasm_bindgen]
pub fn last_panic() -> String {
    LAST_PANIC.try_lock().map(|s| s.clone()).unwrap_or_default()
}

#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        if let Ok(mut s) = LAST_PANIC.try_lock() {
            *s = info.to_string();
        }
    }));
}

// --- the connection: the host's queues ------------------------------------------

struct HostConn {
    host: HostRef,
}

#[async_trait]
impl Connection for HostConn {
    fn get_connection_type(&self) -> ConnectionType {
        ConnectionType::Raw
    }

    async fn read(&mut self, buf: &mut [u8]) -> crate::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let host = self.host.clone();
        std::future::poll_fn(move |_| {
            let mut h = host.lock().unwrap();
            if h.input.is_empty() {
                return if h.closed { Poll::Ready(Ok(0)) } else { Poll::Pending };
            }
            let n = buf.len().min(h.input.len());
            for (d, s) in buf.iter_mut().zip(h.input.drain(..n)) {
                *d = s;
            }
            Poll::Ready(Ok(n))
        })
        .await
    }

    async fn try_read(&mut self, buf: &mut [u8]) -> crate::Result<usize> {
        let mut h = self.host.lock().unwrap();
        let n = buf.len().min(h.input.len());
        for (d, s) in buf.iter_mut().zip(h.input.drain(..n)) {
            *d = s;
        }
        Ok(n)
    }

    async fn send(&mut self, buf: &[u8]) -> crate::Result<()> {
        self.host.lock().unwrap().output.extend_from_slice(buf);
        Ok(())
    }

    fn unread(&mut self, buf: &[u8]) -> crate::Result<()> {
        let mut h = self.host.lock().unwrap();
        for b in buf.iter().rev() {
            h.input.push_front(*b);
        }
        Ok(())
    }
}

/// Pending once. `again` asks the host to poll again soon (output is waiting
/// to go out); otherwise the future rests until the next feed or tick.
struct Yield {
    host: HostRef,
    again: bool,
    done: bool,
}

impl Future for Yield {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if self.done {
            return Poll::Ready(());
        }
        self.done = true;
        if self.again {
            self.host.lock().unwrap().wants_poll = true;
        }
        Poll::Pending
    }
}

/// The protocol yields once this much output is waiting, so the host can pace it.
const OUTPUT_HIGH_WATER: usize = 64 * 1024;

fn copy_log(state: &TransferState, seen: &mut (usize, usize), log: &Mutex<Vec<String>>) {
    let mut l = log.lock().unwrap();
    for (info, idx, tag) in [(&state.send_state, &mut seen.0, "send"), (&state.recieve_state, &mut seen.1, "receive")] {
        for m in info.output_log.iter().skip(*idx) {
            if l.len() < 2000 {
                l.push(match m {
                    OutputLogMessage::Info(s) => format!("{tag}: {s}"),
                    OutputLogMessage::Warning(s) => format!("{tag} warning: {s}"),
                    OutputLogMessage::Error(s) => format!("{tag} error: {s}"),
                });
            }
        }
        *idx = info.output_log.len();
    }
}

fn last_error(state: &TransferState) -> Option<String> {
    state
        .send_state
        .output_log
        .iter()
        .chain(state.recieve_state.output_log.iter())
        .filter_map(|m| if let OutputLogMessage::Error(s) = m { Some(s.clone()) } else { None })
        .last()
}

fn has_info(log: &[OutputLogMessage], needle: &str) -> bool {
    log.iter().any(|m| matches!(m, OutputLogMessage::Info(s) if s.starts_with(needle)))
}

async fn run(host: HostRef, send: bool, files: Vec<PathBuf>, block_len: usize, log: Arc<Mutex<Vec<String>>>) -> std::result::Result<(), String> {
    let mut conn = HostConn { host: host.clone() };
    let mut zm = Zmodem::new(block_len);
    let mut seen = (0, 0);
    let mut sent_files = 0;
    let mut state = if send { zm.initiate_send(&mut conn, &files).await } else { zm.initiate_recv(&mut conn).await }.map_err(|e| e.to_string())?;
    loop {
        let before = {
            let h = host.lock().unwrap();
            (h.input.len(), h.output.len())
        };
        let r = zm.update_transfer(&mut conn, &mut state).await;
        copy_log(&state, &mut seen, &log);
        {
            let mut h = host.lock().unwrap();
            let info = if send { &state.send_state } else { &state.recieve_state };
            h.progress = (info.cur_bytes_transfered, info.file_size);
            // A sent file is done when the receiver has acknowledged it.
            while sent_files < state.send_state.finished_files.len() {
                sent_files += 1;
                h.events.push_back(FileEvent::End);
            }
        }
        if let Err(e) = r {
            return Err(format!("{e}"));
        }
        if state.is_finished {
            break;
        }
        let after = {
            let h = host.lock().unwrap();
            (h.input.len(), h.output.len())
        };
        if after.1 >= OUTPUT_HIGH_WATER {
            Yield { host: host.clone(), again: true, done: false }.await;
        } else if after == before {
            // Nothing consumed and nothing sent (waiting for the remote, or for file data): rest.
            Yield { host: host.clone(), again: false, done: false }.await;
        }
    }
    let ok = if send {
        state.send_state.finished_files.len() == files.len()
            && (has_info(&state.send_state.output_log, "ZFIN received") || has_info(&state.send_state.output_log, "Receiver sent ZFIN"))
    } else {
        has_info(&state.recieve_state.output_log, "ZFIN received")
    };
    if ok { Ok(()) } else { Err(last_error(&state).unwrap_or_else(|| "the transfer was aborted".to_string())) }
}

// --- the wasm-bindgen API ------------------------------------------------------

#[wasm_bindgen]
pub struct ZFileEvent {
    kind: String,
    name: String,
    size: f64,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl ZFileEvent {
    /// "start", "data", "end", "discard" or "skipped".
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> f64 {
        self.size
    }
    /// Moves the data out.
    pub fn take_data(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }
}

type RunFuture = Pin<Box<dyn Future<Output = std::result::Result<(), String>>>>;

#[wasm_bindgen]
pub struct ZSession {
    host: HostRef,
    send: bool,
    block_len: usize,
    files: Vec<PathBuf>,
    fut: Option<RunFuture>,
    result: Option<std::result::Result<(), String>>,
    log: Arc<Mutex<Vec<String>>>,
}

#[wasm_bindgen]
impl ZSession {
    /// `mode`: "receive" (the remote runs sz) or "send" (the remote runs rz).
    /// `block_len`: subpacket size when sending (1024, or 8192 for ZedZap).
    /// `max_file`: largest file accepted when receiving, bytes (0: any).
    #[wasm_bindgen(constructor)]
    pub fn new(mode: &str, now_ms: f64, block_len: usize, max_file: f64) -> ZSession {
        rt::set_now_ms(now_ms);
        let host = Host { max_file: if max_file.is_finite() && max_file > 0.0 { max_file as u64 } else { 0 }, ..Default::default() };
        ZSession {
            host: Arc::new(Mutex::new(host)),
            send: mode == "send",
            block_len: if block_len == 0 { 8192 } else { block_len.clamp(32, 8192) },
            files: Vec::new(),
            fut: None,
            result: None,
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Queue a file to send (before start()). Its data is asked for with need_*().
    pub fn add_file(&mut self, name: String, size: f64) {
        self.files.push(PathBuf::from(&name));
        self.host.lock().unwrap().files.push(Source { name, size: size.max(0.0) as u64, base: 0, data: Vec::new() });
    }

    pub fn start(&mut self) {
        if self.fut.is_some() || self.result.is_some() {
            return;
        }
        let f = run(self.host.clone(), self.send, self.files.clone(), self.block_len, self.log.clone());
        self.fut = Some(Box::pin(f));
        self.poll();
    }

    /// Queue the remote's bytes (poll() to process them).
    pub fn feed(&mut self, data: &[u8]) {
        self.host.lock().unwrap().input.extend(data.iter().copied());
    }

    /// The connection is gone: reads see EOF.
    pub fn close(&mut self) {
        self.host.lock().unwrap().closed = true;
    }

    /// The time (poll() to let timers fire). Polling is the host's call, so
    /// it can hold the protocol while its output cannot go out.
    pub fn tick(&mut self, now_ms: f64) {
        rt::set_now_ms(now_ms);
    }

    pub fn poll(&mut self) {
        self.host.lock().unwrap().wants_poll = false;
        let Some(fut) = self.fut.as_mut() else { return };
        let mut cx = Context::from_waker(Waker::noop());
        let r = rt::with_current(&self.host, || fut.as_mut().poll(&mut cx));
        if let Poll::Ready(r) = r {
            self.fut = None;
            self.result = Some(r);
            self.host.lock().unwrap().wants_poll = false;
        }
    }

    /// The protocol yielded with work left: poll() again soon (after sending the output).
    pub fn wants_poll(&self) -> bool {
        self.host.lock().unwrap().wants_poll
    }

    pub fn output_len(&self) -> usize {
        self.host.lock().unwrap().output.len()
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.host.lock().unwrap().output)
    }

    /// Bytes the protocol did not read (after the end: they belong to the screen).
    pub fn take_input(&mut self) -> Vec<u8> {
        self.host.lock().unwrap().input.drain(..).collect()
    }

    /// The file whose data the sender waits for (-1: none), from need_offset(), need_len() bytes.
    pub fn need_file(&self) -> i32 {
        self.host.lock().unwrap().need.map(|n| n.0 as i32).unwrap_or(-1)
    }
    pub fn need_offset(&self) -> f64 {
        self.host.lock().unwrap().need.map(|n| n.1 as f64).unwrap_or(0.0)
    }
    pub fn need_len(&self) -> usize {
        self.host.lock().unwrap().need.map(|n| n.2).unwrap_or(0)
    }

    /// File data from `offset`: the new window of file `idx` (poll() to go on).
    pub fn provide(&mut self, idx: usize, offset: f64, data: Vec<u8>) {
        let mut h = self.host.lock().unwrap();
        if let Some(f) = h.files.get_mut(idx) {
            f.base = offset.max(0.0) as u64;
            f.data = data;
        }
        h.need = None;
    }

    pub fn progress_bytes(&self) -> f64 {
        self.host.lock().unwrap().progress.0 as f64
    }

    pub fn next_event(&mut self) -> Option<ZFileEvent> {
        let ev = self.host.lock().unwrap().events.pop_front()?;
        let e = |kind: &str, name: String, size: u64, data: Vec<u8>| ZFileEvent { kind: kind.into(), name, size: size as f64, data };
        Some(match ev {
            FileEvent::Start { name, size } => e("start", name, size, Vec::new()),
            FileEvent::Data(data) => {
                let n = data.len() as u64;
                e("data", String::new(), n, data)
            }
            FileEvent::End => e("end", String::new(), 0, Vec::new()),
            FileEvent::Discard => e("discard", String::new(), 0, Vec::new()),
            FileEvent::Skipped { name, size } => e("skipped", name, size, Vec::new()),
        })
    }

    /// 0: running (or not started), 1: finished, 2: failed.
    pub fn status(&self) -> u8 {
        match &self.result {
            None => 0,
            Some(Ok(())) => 1,
            Some(Err(_)) => 2,
        }
    }

    pub fn error(&self) -> Option<String> {
        match &self.result {
            Some(Err(e)) => Some(e.clone()),
            _ => None,
        }
    }

    pub fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }

    /// Cancel from this side: drop the protocol state and send the abort sequence.
    pub fn cancel(&mut self) {
        self.fut = None; // drops Rz/Sz: an open received file sends "discard"
        let mut conn = HostConn { host: self.host.clone() };
        let mut zm = Zmodem::new(self.block_len);
        let mut f = zm.cancel_transfer(&mut conn);
        let mut cx = Context::from_waker(Waker::noop());
        let _ = f.as_mut().poll(&mut cx); // send() never waits
        if self.result.is_none() {
            self.result = Some(Err("cancelled".to_string()));
        }
    }
}
