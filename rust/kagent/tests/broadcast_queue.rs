use kagent::utils::{BroadcastQueue, QueueShutDown};

#[tokio::test]
async fn test_basic_publish_subscribe() {
    let broadcast = BroadcastQueue::new();
    let queue1 = broadcast.subscribe();
    let queue2 = broadcast.subscribe();

    broadcast.publish("test_message").await.unwrap();

    assert_eq!(queue1.get().await.unwrap(), "test_message");
    assert_eq!(queue2.get().await.unwrap(), "test_message");
}

#[tokio::test]
async fn test_publish_nowait() {
    let broadcast = BroadcastQueue::new();
    let queue = broadcast.subscribe();

    broadcast.publish_nowait("fast_message").unwrap();

    assert_eq!(queue.get().await.unwrap(), "fast_message");
}

#[tokio::test]
async fn test_unsubscribe() {
    let broadcast = BroadcastQueue::new();
    let queue1 = broadcast.subscribe();
    let queue2 = broadcast.subscribe();

    broadcast.unsubscribe(&queue2);
    broadcast.publish("only_for_queue1").await.unwrap();

    assert_eq!(queue1.get().await.unwrap(), "only_for_queue1");
    assert_eq!(queue2.qsize(), 0);
}

#[tokio::test]
async fn test_multiple_subscribers_receive_same_message() {
    let broadcast = BroadcastQueue::new();
    let queues: Vec<_> = (0..5).map(|_| broadcast.subscribe()).collect();

    let test_msg = serde_json::json!({ "type": "test", "data": [1, 2, 3] });
    broadcast.publish(test_msg.clone()).await.unwrap();

    let mut results = Vec::new();
    for queue in queues {
        results.push(queue.get().await.unwrap());
    }
    assert!(results.iter().all(|item| item == &test_msg));
}

#[tokio::test]
async fn test_shutdown() {
    let broadcast: BroadcastQueue<&str> = BroadcastQueue::new();
    let queue1 = broadcast.subscribe();
    let queue2 = broadcast.subscribe();

    broadcast.shutdown(false);

    assert_eq!(queue1.get_nowait(), Err(QueueShutDown));
    assert_eq!(queue2.get_nowait(), Err(QueueShutDown));
}

#[tokio::test]
async fn test_publish_to_empty_queue() {
    let broadcast: BroadcastQueue<&str> = BroadcastQueue::new();

    broadcast.publish("no_subscribers").await.unwrap();
    broadcast.publish_nowait("no_subscribers").unwrap();
}
