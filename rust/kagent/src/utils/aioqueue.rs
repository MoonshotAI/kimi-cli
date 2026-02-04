use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
#[error("queue is shut down")]
pub struct QueueShutDown;

#[derive(Clone)]
pub struct Queue<T> {
    inner: Arc<QueueInner<T>>,
}

struct QueueInner<T> {
    sender: Mutex<Option<mpsc::UnboundedSender<T>>>,
    receiver: tokio::sync::Mutex<mpsc::UnboundedReceiver<T>>,
    shutdown: AtomicBool,
    len: AtomicUsize,
}

impl<T> Queue<T> {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(QueueInner {
                sender: Mutex::new(Some(sender)),
                receiver: tokio::sync::Mutex::new(receiver),
                shutdown: AtomicBool::new(false),
                len: AtomicUsize::new(0),
            }),
        }
    }

    pub fn shutdown(&self, immediate: bool) {
        if self.inner.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut sender = self.inner.sender.lock().unwrap();
        sender.take();

        if immediate {
            let mut receiver = self.inner.receiver.blocking_lock();
            while receiver.try_recv().is_ok() {}
            self.inner.len.store(0, Ordering::SeqCst);
        }
    }

    pub async fn get(&self) -> Result<T, QueueShutDown> {
        let mut receiver = self.inner.receiver.lock().await;
        match receiver.recv().await {
            Some(item) => {
                self.inner.len.fetch_sub(1, Ordering::SeqCst);
                Ok(item)
            }
            None => Err(QueueShutDown),
        }
    }

    pub fn get_nowait(&self) -> Result<T, QueueShutDown> {
        let mut receiver = self.inner.receiver.try_lock().map_err(|_| QueueShutDown)?;
        match receiver.try_recv() {
            Ok(item) => {
                self.inner.len.fetch_sub(1, Ordering::SeqCst);
                Ok(item)
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => Err(QueueShutDown),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => Err(QueueShutDown),
        }
    }

    pub async fn put(&self, item: T) -> Result<(), QueueShutDown> {
        self.put_nowait(item)
    }

    pub fn put_nowait(&self, item: T) -> Result<(), QueueShutDown> {
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return Err(QueueShutDown);
        }
        let sender = self.inner.sender.lock().unwrap();
        let sender = sender.as_ref().ok_or(QueueShutDown)?;
        sender.send(item).map_err(|_| QueueShutDown)?;
        self.inner.len.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn ptr_eq(&self, other: &Queue<T>) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn qsize(&self) -> usize {
        self.inner.len.load(Ordering::SeqCst)
    }
}
