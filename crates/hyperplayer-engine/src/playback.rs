use crate::error::{EngineError, Result};
use crate::model::QueueItem;
use crate::queue::{
    PlaybackMode, PlaybackQueue, QueueContextSnapshot, QueueInsertPosition, QueueSection,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaybackState {
    Idle,
    Loading {
        item: QueueItem,
    },
    Playing {
        item: QueueItem,
        position_ms: u64,
    },
    Paused {
        item: QueueItem,
        position_ms: u64,
    },
    Stopped {
        item: QueueItem,
    },
    Failed {
        item: Option<QueueItem>,
        reason: String,
    },
}

impl PlaybackState {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading { .. } => "loading",
            Self::Playing { .. } => "playing",
            Self::Paused { .. } => "paused",
            Self::Stopped { .. } => "stopped",
            Self::Failed { .. } => "failed",
        }
    }

    pub fn current(&self) -> Option<&QueueItem> {
        match self {
            Self::Idle => None,
            Self::Loading { item }
            | Self::Playing { item, .. }
            | Self::Paused { item, .. }
            | Self::Stopped { item } => Some(item),
            Self::Failed { item, .. } => item.as_ref(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybackSnapshot {
    pub state: PlaybackState,
    pub mode: PlaybackMode,
    pub next: Option<QueueItem>,
    pub priority_count: usize,
    pub context_count: usize,
    pub queue: QueueContextSnapshot,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct PlaybackMachine {
    state: PlaybackState,
    queue: PlaybackQueue,
    revision: u64,
}

impl PlaybackMachine {
    pub fn new(shuffle_seed: u64) -> Self {
        Self {
            state: PlaybackState::Idle,
            queue: PlaybackQueue::new(shuffle_seed),
            revision: 0,
        }
    }

    pub fn queue(&self) -> &PlaybackQueue {
        &self.queue
    }

    pub fn state(&self) -> &PlaybackState {
        &self.state
    }

    pub fn snapshot(&self) -> PlaybackSnapshot {
        PlaybackSnapshot {
            state: self.state.clone(),
            mode: self.queue.mode(),
            next: self.queue.peek_next(false).cloned(),
            priority_count: self.queue.priority().len(),
            context_count: self.queue.context().len(),
            queue: self.queue.context_snapshot(),
            revision: self.revision,
        }
    }

    pub fn load_context(&mut self, items: Vec<QueueItem>, start_index: usize) -> Result<()> {
        if !self.queue.replace_context(items, start_index) {
            return Err(EngineError::InvalidInput(
                "queue context is empty or start index is out of bounds".into(),
            ));
        }
        self.state = PlaybackState::Loading {
            item: self
                .queue
                .current()
                .expect("queue accepted start index")
                .clone(),
        };
        self.bump_revision();
        Ok(())
    }

    pub fn restore_queue(&mut self, queue: PlaybackQueue, position_ms: u64) {
        let current = queue.current().cloned();
        self.queue = queue;
        self.state = current.map_or(PlaybackState::Idle, |item| PlaybackState::Paused {
            item,
            position_ms,
        });
        self.bump_revision();
    }

    pub fn ready(&mut self) -> Result<()> {
        let item = match &self.state {
            PlaybackState::Loading { item } => item.clone(),
            state => return Err(invalid(state, "ready")),
        };
        self.state = PlaybackState::Playing {
            item,
            position_ms: 0,
        };
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        let (item, position_ms) = match &self.state {
            PlaybackState::Playing { item, position_ms } => (item.clone(), *position_ms),
            state => return Err(invalid(state, "pause")),
        };
        self.state = PlaybackState::Paused { item, position_ms };
        Ok(())
    }

    pub fn resume(&mut self) -> Result<()> {
        let (item, position_ms) = match &self.state {
            PlaybackState::Paused { item, position_ms } => (item.clone(), *position_ms),
            state => return Err(invalid(state, "resume")),
        };
        self.state = PlaybackState::Playing { item, position_ms };
        Ok(())
    }

    pub fn seek(&mut self, position_ms: u64) -> Result<()> {
        match &mut self.state {
            PlaybackState::Playing {
                position_ms: current,
                ..
            }
            | PlaybackState::Paused {
                position_ms: current,
                ..
            } => {
                *current = position_ms;
                Ok(())
            }
            state => Err(invalid(state, "seek")),
        }
    }

    pub fn update_position(&mut self, position_ms: u64) -> Result<()> {
        match &mut self.state {
            PlaybackState::Playing {
                position_ms: current,
                ..
            } => {
                *current = position_ms;
                Ok(())
            }
            state => Err(invalid(state, "update_position")),
        }
    }

    pub fn stop(&mut self) -> Result<()> {
        let item = self
            .state
            .current()
            .cloned()
            .ok_or_else(|| invalid(&self.state, "stop"))?;
        self.state = PlaybackState::Stopped { item };
        Ok(())
    }

    pub fn fail(&mut self, reason: impl Into<String>) {
        self.state = PlaybackState::Failed {
            item: self.state.current().cloned(),
            reason: reason.into(),
        };
    }

    pub fn set_mode(&mut self, mode: PlaybackMode) {
        self.queue.set_mode(mode);
        self.bump_revision();
    }

    pub fn play_next(&mut self, item: QueueItem) {
        self.queue.play_next(item);
        self.bump_revision();
    }

    pub fn enqueue(&mut self, item: QueueItem, position: QueueInsertPosition) {
        let had_current = self.queue.current().is_some();
        match position {
            QueueInsertPosition::PlayNext => self.queue.play_next(item),
            QueueInsertPosition::ContextEnd => self.queue.append_context(item),
        }
        if !had_current {
            if let Some(item) = self.queue.current().cloned() {
                self.state = PlaybackState::Paused {
                    item,
                    position_ms: 0,
                };
            }
        }
        self.bump_revision();
    }

    pub fn remove(&mut self, queue_id: u64) -> Result<bool> {
        let previous = self.queue.current().map(|item| item.queue_id);
        self.queue.remove(queue_id).ok_or_else(|| {
            EngineError::InvalidInput(format!("queue item does not exist: {queue_id}"))
        })?;
        let current_changed = self.queue.current().map(|item| item.queue_id) != previous;
        if current_changed {
            self.reset_state_to_queue();
        }
        self.bump_revision();
        Ok(current_changed)
    }

    pub fn reorder(&mut self, section: QueueSection, from: usize, to: usize) -> Result<()> {
        if !self.queue.reorder(section, from, to) {
            return Err(EngineError::InvalidInput(
                "target index is outside the queue section".into(),
            ));
        }
        self.bump_revision();
        Ok(())
    }

    pub fn clear_priority(&mut self) {
        self.queue.clear_priority();
        self.bump_revision();
    }

    pub fn clear_all(&mut self) -> bool {
        let had_current = self.queue.current().is_some();
        self.queue.clear_all();
        self.state = PlaybackState::Idle;
        self.bump_revision();
        had_current
    }

    pub fn next(&mut self, automatic: bool) -> Result<()> {
        let item = self
            .queue
            .advance(automatic)
            .cloned()
            .ok_or_else(|| EngineError::InvalidInput("queue has no next item".into()))?;
        self.state = PlaybackState::Loading { item };
        self.bump_revision();
        Ok(())
    }

    pub fn previous(&mut self) -> Result<()> {
        let item = self
            .queue
            .previous()
            .cloned()
            .ok_or_else(|| EngineError::InvalidInput("playback history is empty".into()))?;
        self.state = PlaybackState::Loading { item };
        self.bump_revision();
        Ok(())
    }

    fn reset_state_to_queue(&mut self) {
        self.state = self
            .queue
            .current()
            .cloned()
            .map_or(PlaybackState::Idle, |item| PlaybackState::Stopped { item });
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

fn invalid(state: &PlaybackState, command: &'static str) -> EngineError {
    EngineError::InvalidTransition {
        from: state.name(),
        command,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::test_item;

    #[test]
    fn validates_transitions_and_preserves_position() {
        let mut machine = PlaybackMachine::new(7);
        assert!(machine.pause().is_err());
        machine.load_context(vec![test_item(1)], 0).unwrap();
        machine.ready().unwrap();
        machine.seek(15_000).unwrap();
        machine.pause().unwrap();
        machine.resume().unwrap();

        assert!(matches!(
            machine.state(),
            PlaybackState::Playing {
                position_ms: 15_000,
                ..
            }
        ));
    }

    #[test]
    fn failed_state_never_claims_playback() {
        let mut machine = PlaybackMachine::new(7);
        machine.load_context(vec![test_item(1)], 0).unwrap();
        machine.fail("decoder unavailable");
        assert!(matches!(machine.state(), PlaybackState::Failed { .. }));
        assert!(machine.resume().is_err());
    }
}
