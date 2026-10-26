//! What icy_net's ZModem code gets from the platform, for wasm32 in a
//! browser (patches/icy_board/0001 points its imports here):
//!
//! - `Instant`: `std::time::Instant::now()` panics on wasm32-unknown-unknown,
//!   so the host injects the clock (`ZSession::tick(now_ms)`).
//! - `sleep`/`timeout`: there is no tokio; these futures only look at the
//!   injected clock and stay Pending until it passes their deadline. The host
//!   polls again on every feed() and tick().
//! - `SourceReader` (sending) replaces `BufReader<File>`: a window of the file
//!   that the host fills as the protocol asks for it (`ready()` waits for the
//!   window; patch 0004), so a large upload is never held whole.
//! - `NamedTempFile` (receiving) replaces tempfile's: the data goes out to the
//!   host as start/data/end events instead of into a file.
//! - `accept_file`: the host may refuse a file it was offered (patch 0004).
use std::{
    cell::RefCell,
    collections::VecDeque,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

static NOW_MS: AtomicU64 = AtomicU64::new(0);

pub fn set_now_ms(ms: f64) {
    if ms.is_finite() && ms >= 0.0 {
        NOW_MS.store(ms as u64, Ordering::Relaxed);
    }
}

pub fn now_ms() -> u64 {
    NOW_MS.load(Ordering::Relaxed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Instant(u64);

impl Instant {
    pub fn now() -> Self {
        Instant(now_ms())
    }
    pub fn elapsed(&self) -> Duration {
        Duration::from_millis(now_ms().saturating_sub(self.0))
    }
    pub fn duration_since(&self, earlier: Instant) -> Duration {
        Duration::from_millis(self.0.saturating_sub(earlier.0))
    }
}

pub struct Sleep {
    deadline: u64,
}

pub fn sleep(d: Duration) -> Sleep {
    Sleep { deadline: now_ms() + d.as_millis() as u64 }
}

impl Future for Sleep {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if now_ms() >= self.deadline { Poll::Ready(()) } else { Poll::Pending }
    }
}

#[derive(Debug)]
pub struct Elapsed;

pub struct Timeout<F: Future> {
    fut: Pin<Box<F>>,
    deadline: u64,
}

pub fn timeout<F: Future>(d: Duration, fut: F) -> Timeout<F> {
    Timeout { fut: Box::pin(fut), deadline: now_ms() + d.as_millis() as u64 }
}

impl<F: Future> Future for Timeout<F> {
    type Output = Result<F::Output, Elapsed>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Poll::Ready(v) = self.fut.as_mut().poll(cx) {
            return Poll::Ready(Ok(v));
        }
        if now_ms() >= self.deadline { Poll::Ready(Err(Elapsed)) } else { Poll::Pending }
    }
}

// --- the host side of a session, shared by the protocol and the wrapper ------

pub enum FileEvent {
    /// A file begins: offered to us (receiving) or opened to send.
    Start { name: String, size: u64 },
    Data(Vec<u8>),
    /// The file is complete (received to ZEOF, or acknowledged by the receiver).
    End,
    /// Abandoned before its end (the session failed or was cancelled).
    Discard,
    /// Offered, and refused by the host (`max_file`).
    Skipped { name: String, size: u64 },
}

pub struct Source {
    pub name: String,
    pub size: u64,
    /// The window of the file the host has filled: `data` starts at `base`.
    pub base: u64,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct Host {
    pub input: VecDeque<u8>,
    pub output: Vec<u8>,
    pub closed: bool,
    pub files: Vec<Source>,
    pub events: VecDeque<FileEvent>,
    /// The protocol yielded with work to do: poll again soon.
    pub wants_poll: bool,
    /// The sender waits for this (file, offset, length) from the host.
    pub need: Option<(usize, u64, usize)>,
    /// Largest file to accept when receiving (0: any).
    pub max_file: u64,
    /// Bytes of the current file done, and its size.
    pub progress: (u64, u64),
    /// The received file being written (its NamedTempFile's generation), if any.
    pub open_file: Option<u64>,
    pub file_gen: u64,
}

pub type HostRef = Arc<Mutex<Host>>;

thread_local! {
    static CURRENT: RefCell<Option<HostRef>> = const { RefCell::new(None) };
}

/// Run `f` with `host` as the session the shims below work on.
pub fn with_current<R>(host: &HostRef, f: impl FnOnce() -> R) -> R {
    CURRENT.with(|c| *c.borrow_mut() = Some(host.clone()));
    let r = f();
    CURRENT.with(|c| *c.borrow_mut() = None);
    r
}

fn current() -> io::Result<HostRef> {
    CURRENT.with(|c| c.borrow().clone()).ok_or_else(|| io::Error::other("no active ZModem session"))
}

/// The host refuses files larger than its limit: they are skipped (ZSKIP).
pub fn accept_file(name: &str, size: u64) -> bool {
    let Ok(host) = current() else { return true };
    let mut h = host.lock().unwrap();
    if h.max_file != 0 && size > h.max_file {
        h.events.push_back(FileEvent::Skipped { name: name.to_string(), size });
        return false;
    }
    true
}

/// More than this is asked of the host at once.
const READ_CHUNK: usize = 64 * 1024;

/// Replaces `BufReader<File>` in sz.rs: a seekable reader over the window
/// of the file the host provides.
pub struct SourceReader {
    host: HostRef,
    idx: usize,
    pos: u64,
    size: u64,
}

impl SourceReader {
    fn find(path: &Path) -> io::Result<(HostRef, usize, u64)> {
        let host = current()?;
        let key = path.to_string_lossy();
        let idx = host.lock().unwrap().files.iter().position(|f| f.name == key);
        let idx = idx.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no such file {key}")))?;
        let size = host.lock().unwrap().files[idx].size;
        Ok((host, idx, size))
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let (host, idx, size) = Self::find(path)?;
        {
            let mut h = host.lock().unwrap();
            let name = h.files[idx].name.clone();
            h.events.push_back(FileEvent::Start { name, size });
        }
        Ok(Self { host, idx, pos: 0, size })
    }

    pub fn len(path: &Path) -> io::Result<u64> {
        Ok(Self::find(path)?.2)
    }

    /// Wait until the next `n` bytes (or the rest of the file) are in the window.
    pub async fn ready(&mut self, n: usize) -> io::Result<()> {
        let (host, idx, pos, size) = (self.host.clone(), self.idx, self.pos, self.size);
        std::future::poll_fn(move |_| {
            let mut h = host.lock().unwrap();
            if h.closed {
                return Poll::Ready(Err(io::Error::other("connection closed")));
            }
            let end = size.min(pos + n as u64);
            let f = &h.files[idx];
            if pos >= size || (f.base <= pos && f.base + f.data.len() as u64 >= end) {
                h.need = None;
                return Poll::Ready(Ok(()));
            }
            let len = (size - pos).min(n.max(READ_CHUNK) as u64) as usize;
            h.need = Some((idx, pos, len));
            Poll::Pending
        })
        .await
    }
}

impl io::Read for SourceReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let h = self.host.lock().unwrap();
        let f = &h.files[self.idx];
        if self.pos >= self.size {
            return Ok(0);
        }
        if self.pos < f.base || self.pos >= f.base + f.data.len() as u64 {
            return Err(io::Error::other("file data not loaded"));
        }
        let start = (self.pos - f.base) as usize;
        let n = buf.len().min(f.data.len() - start);
        buf[..n].copy_from_slice(&f.data[start..start + n]);
        drop(h);
        self.pos += n as u64;
        Ok(n)
    }
}

impl io::Seek for SourceReader {
    fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
        let new = match pos {
            io::SeekFrom::Start(p) => p as i64,
            io::SeekFrom::End(o) => self.size as i64 + o,
            io::SeekFrom::Current(o) => self.pos as i64 + o,
        };
        if new < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

/// Replaces tempfile's `NamedTempFile` in rz.rs: the file goes out to the host.
pub struct NamedTempFile {
    host: HostRef,
    name: PathBuf,
    kept: bool,
    gen_: u64,
}

/// Received data goes out in events of at most this many bytes.
const DATA_EVENT_MAX: usize = 64 * 1024;

impl NamedTempFile {
    /// A new received file. rz replaces an open one (a repeated ZFILE) by
    /// assigning over it, which drops the old one only after this: so the
    /// old one is discarded here, first, and its drop says nothing more.
    pub fn create(name: &str, size: u64) -> io::Result<Self> {
        let host = current()?;
        let mut h = host.lock().unwrap();
        if h.open_file.take().is_some() {
            h.events.push_back(FileEvent::Discard);
        }
        h.file_gen += 1;
        let gen_ = h.file_gen;
        h.open_file = Some(gen_);
        h.events.push_back(FileEvent::Start { name: name.to_string(), size });
        drop(h);
        Ok(Self { host, name: PathBuf::from(name), kept: false, gen_ })
    }
    pub fn as_file_mut(&mut self) -> &mut Self {
        self
    }
    pub fn keep(mut self) -> io::Result<((), PathBuf)> {
        self.kept = true;
        let mut h = self.host.lock().unwrap();
        if h.open_file == Some(self.gen_) {
            h.open_file = None;
            h.events.push_back(FileEvent::End);
        }
        drop(h);
        Ok(((), self.name.clone()))
    }
}

impl io::Write for NamedTempFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut h = self.host.lock().unwrap();
        if h.open_file != Some(self.gen_) {
            return Ok(buf.len()); // replaced: nothing of it goes out any more
        }
        if let Some(FileEvent::Data(last)) = h.events.back_mut() {
            if last.len() + buf.len() <= DATA_EVENT_MAX {
                last.extend_from_slice(buf);
                return Ok(buf.len());
            }
        }
        h.events.push_back(FileEvent::Data(buf.to_vec()));
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for NamedTempFile {
    fn drop(&mut self) {
        if !self.kept {
            if let Ok(mut h) = self.host.lock() {
                if h.open_file == Some(self.gen_) {
                    h.open_file = None;
                    h.events.push_back(FileEvent::Discard);
                }
            }
        }
    }
}
