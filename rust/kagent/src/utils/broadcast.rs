use std::sync::Mutex;

use super::aioqueue::{Queue, QueueShutDown};

pub struct BroadcastQueue<T: Clone> {
    queues: Mutex<Vec<Queue<T>>>,
}

impl<T: Clone> BroadcastQueue<T> {
    pub fn new() -> Self {
        Self {
            queues: Mutex::new(Vec::new()),
        }
    }

    pub fn subscribe(&self) -> Queue<T> {
        let queue = Queue::new();
        self.queues.lock().unwrap().push(queue.clone());
        queue
    }

    pub fn unsubscribe(&self, queue: &Queue<T>) {
        let mut queues = self.queues.lock().unwrap();
        queues.retain(|item| !item.ptr_eq(queue));
    }

    pub async fn publish(&self, item: T) -> Result<(), QueueShutDown> {
        let queues = self.queues.lock().unwrap().clone();
        for queue in queues {
            queue.put(item.clone()).await?;
        }
        Ok(())
    }

    pub fn publish_nowait(&self, item: T) -> Result<(), QueueShutDown> {
        let queues = self.queues.lock().unwrap().clone();
        for queue in queues {
            queue.put_nowait(item.clone())?;
        }
        Ok(())
    }

    pub fn shutdown(&self, immediate: bool) {
        let mut queues = self.queues.lock().unwrap();
        for queue in queues.iter() {
            queue.shutdown(immediate);
        }
        queues.clear();
    }
}
