//! Bounded per-socket delivery. A slow peer cannot accumulate unlimited memory
//! or stall a room. Revocation bypasses the data queue.
use axum::extract::ws::Message;
use std::sync::Arc;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};

const MAX_OUTBOUND_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub(crate) struct Outbound {
    tx: mpsc::Sender<Frame>,
    budget: Arc<Semaphore>,
    close: watch::Sender<Option<&'static str>>,
}
pub(crate) struct Frame {
    pub message: Message,
    _budget: OwnedSemaphorePermit,
}
impl Outbound {
    pub fn channel() -> (
        Self,
        mpsc::Receiver<Frame>,
        watch::Receiver<Option<&'static str>>,
    ) {
        let (tx, rx) = mpsc::channel(256);
        let (close, closed) = watch::channel(None);
        (
            Self {
                tx,
                close,
                budget: Arc::new(Semaphore::new(MAX_OUTBOUND_BYTES)),
            },
            rx,
            closed,
        )
    }
    pub fn send(&self, message: Message) -> Result<(), ()> {
        if self.close.borrow().is_some() {
            return Err(());
        }
        let bytes = match &message {
            Message::Binary(v) | Message::Ping(v) | Message::Pong(v) => v.len(),
            Message::Text(v) => v.len(),
            Message::Close(_) => 128,
        }
        .max(1);
        let permit = self
            .budget
            .clone()
            .try_acquire_many_owned(bytes.min(u32::MAX as usize) as u32);
        if let Ok(permit) = permit {
            if self
                .tx
                .try_send(Frame {
                    message,
                    _budget: permit,
                })
                .is_ok()
            {
                return Ok(());
            }
        }
        self.close("Slow connection; reconnect to synchronize");
        Err(())
    }
    pub fn close(&self, reason: &'static str) {
        self.close.send_replace(Some(reason));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queue_overflow_closes_instead_of_unbounded_growth() {
        let (sender, _receiver, close) = Outbound::channel();
        for _ in 0..256 {
            assert!(sender.send(Message::Binary(vec![1].into())).is_ok());
        }
        assert!(sender.send(Message::Binary(vec![1].into())).is_err());
        assert!(close.borrow().is_some());
    }
    #[tokio::test]
    async fn byte_budget_is_released_after_delivery() {
        let (sender, mut receiver, close) = Outbound::channel();
        assert!(sender
            .send(Message::Binary(vec![1; MAX_OUTBOUND_BYTES].into()))
            .is_ok());
        drop(receiver.recv().await.unwrap());
        assert!(sender
            .send(Message::Binary(vec![1; MAX_OUTBOUND_BYTES].into()))
            .is_ok());
        assert!(close.borrow().is_none());
        sender.close("Access revoked");
        assert_eq!(*close.borrow(), Some("Access revoked"));
        assert!(sender.send(Message::Binary(vec![1].into())).is_err());
    }
}
