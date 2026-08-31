use crate::model::QueueItem;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackMode {
    #[default]
    Sequential,
    RepeatAll,
    RepeatOne,
    Shuffle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueContextSnapshot {
    pub current: Option<QueueItem>,
    pub priority: Vec<QueueItem>,
    pub context: Vec<QueueItem>,
    pub context_cursor: Option<usize>,
    pub mode: PlaybackMode,
    pub shuffle_seed: u64,
    pub traversal_history: Vec<QueueItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueSection {
    Priority,
    Context,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueInsertPosition {
    PlayNext,
    ContextEnd,
}

impl PlaybackMode {
    pub fn next(self) -> Self {
        match self {
            Self::Sequential => Self::RepeatAll,
            Self::RepeatAll => Self::RepeatOne,
            Self::RepeatOne => Self::Shuffle,
            Self::Shuffle => Self::Sequential,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybackQueue {
    current: Option<QueueItem>,
    priority: VecDeque<QueueItem>,
    context: Vec<QueueItem>,
    context_cursor: Option<usize>,
    mode: PlaybackMode,
    shuffle_seed: u64,
    shuffle_order: Vec<usize>,
    shuffle_cursor: Option<usize>,
    history: Vec<QueueItem>,
}

impl PlaybackQueue {
    pub fn new(shuffle_seed: u64) -> Self {
        Self {
            shuffle_seed,
            ..Self::default()
        }
    }

    pub fn current(&self) -> Option<&QueueItem> {
        self.current.as_ref()
    }

    pub fn priority(&self) -> &VecDeque<QueueItem> {
        &self.priority
    }

    pub fn context(&self) -> &[QueueItem] {
        &self.context
    }

    pub fn mode(&self) -> PlaybackMode {
        self.mode
    }

    pub fn traversal_history(&self) -> &[QueueItem] {
        &self.history
    }

    pub fn context_snapshot(&self) -> QueueContextSnapshot {
        QueueContextSnapshot {
            current: self.current.clone(),
            priority: self.priority.iter().cloned().collect(),
            context: self.context.clone(),
            context_cursor: self.context_cursor,
            mode: self.mode,
            shuffle_seed: self.shuffle_seed,
            traversal_history: self.history.clone(),
        }
    }

    pub fn restore(snapshot: QueueContextSnapshot) -> Option<Self> {
        if snapshot
            .context_cursor
            .is_some_and(|index| index >= snapshot.context.len())
        {
            return None;
        }
        let mut queue = Self {
            current: snapshot.current,
            priority: snapshot.priority.into(),
            context: snapshot.context,
            context_cursor: snapshot.context_cursor,
            mode: snapshot.mode,
            shuffle_seed: snapshot.shuffle_seed,
            shuffle_order: Vec::new(),
            shuffle_cursor: None,
            history: snapshot.traversal_history,
        };
        queue.rebuild_shuffle();
        Some(queue)
    }

    pub fn set_mode(&mut self, mode: PlaybackMode) {
        self.mode = mode;
        if mode == PlaybackMode::Shuffle {
            self.rebuild_shuffle();
        }
    }

    pub fn cycle_mode(&mut self) -> PlaybackMode {
        let mode = self.mode.next();
        self.set_mode(mode);
        mode
    }

    pub fn replace_context(&mut self, items: Vec<QueueItem>, start_index: usize) -> bool {
        if items.is_empty() || start_index >= items.len() {
            return false;
        }
        self.context = items;
        self.context_cursor = Some(start_index);
        self.current = self.context.get(start_index).cloned();
        self.history.clear();
        self.rebuild_shuffle();
        true
    }

    pub fn play_next(&mut self, item: QueueItem) {
        self.priority.push_back(item);
    }

    pub fn append_priority(&mut self, item: QueueItem) {
        self.priority.push_back(item);
    }

    pub fn append_context(&mut self, item: QueueItem) {
        if self.current.is_none() {
            self.context.push(item.clone());
            self.context_cursor = Some(0);
            self.current = Some(item);
        } else {
            self.context.push(item);
        }
        self.rebuild_shuffle();
    }

    pub fn clear_priority(&mut self) {
        self.priority.clear();
    }

    pub fn clear_context(&mut self) {
        self.current = None;
        self.context.clear();
        self.context_cursor = None;
        self.shuffle_order.clear();
        self.shuffle_cursor = None;
        self.history.clear();
    }

    pub fn remove(&mut self, queue_id: u64) -> Option<QueueItem> {
        if let Some(index) = self
            .priority
            .iter()
            .position(|item| item.queue_id == queue_id)
        {
            return self.priority.remove(index);
        }
        let index = self
            .context
            .iter()
            .position(|item| item.queue_id == queue_id)?;
        let removed = self.context.remove(index);
        let removed_current = self
            .current
            .as_ref()
            .is_some_and(|item| item.queue_id == queue_id);
        match self.context_cursor {
            Some(cursor) if cursor == index && removed_current => {
                if self.context.is_empty() {
                    self.current = None;
                    self.context_cursor = None;
                    self.history.clear();
                } else {
                    let replacement = index.min(self.context.len() - 1);
                    self.context_cursor = Some(replacement);
                    self.current = self.context.get(replacement).cloned();
                }
            }
            Some(cursor) if cursor > index => self.context_cursor = Some(cursor - 1),
            _ => {}
        }
        self.history.retain(|item| item.queue_id != queue_id);
        self.rebuild_shuffle();
        Some(removed)
    }

    pub fn reorder(&mut self, section: QueueSection, from: usize, to: usize) -> bool {
        match section {
            QueueSection::Priority => move_vec_deque(&mut self.priority, from, to),
            QueueSection::Context => {
                if from >= self.context.len() || to >= self.context.len() || from == to {
                    return from == to && from < self.context.len();
                }
                let item = self.context.remove(from);
                self.context.insert(to, item);
                if let Some(cursor) = self.context_cursor {
                    self.context_cursor = Some(remap_index_after_move(cursor, from, to));
                }
                self.rebuild_shuffle();
                true
            }
        }
    }

    pub fn clear_all(&mut self) {
        self.current = None;
        self.priority.clear();
        self.context.clear();
        self.context_cursor = None;
        self.shuffle_order.clear();
        self.shuffle_cursor = None;
        self.history.clear();
    }

    pub fn peek_next(&self, automatic: bool) -> Option<&QueueItem> {
        if let Some(item) = self.priority.front() {
            return Some(item);
        }
        if automatic && self.mode == PlaybackMode::RepeatOne {
            return self.current.as_ref();
        }
        self.peek_context_next()
    }

    pub fn advance(&mut self, automatic: bool) -> Option<&QueueItem> {
        if let Some(item) = self.priority.pop_front() {
            self.remember_current();
            self.current = Some(item);
            return self.current.as_ref();
        }
        if automatic && self.mode == PlaybackMode::RepeatOne {
            return self.current.as_ref();
        }

        let next_index = self.next_context_index()?;
        self.remember_current();
        self.context_cursor = Some(next_index);
        self.current = self.context.get(next_index).cloned();
        if self.mode == PlaybackMode::Shuffle {
            self.shuffle_cursor = self
                .shuffle_order
                .iter()
                .position(|candidate| *candidate == next_index);
        }
        self.current.as_ref()
    }

    pub fn previous(&mut self) -> Option<&QueueItem> {
        let previous = self.history.pop()?;
        if let Some(current) = self.current.replace(previous) {
            self.priority.push_front(current);
        }
        self.current.as_ref()
    }

    fn remember_current(&mut self) {
        if let Some(current) = self.current.clone() {
            self.history.push(current);
        }
    }

    fn peek_context_next(&self) -> Option<&QueueItem> {
        self.next_context_index()
            .and_then(|index| self.context.get(index))
    }

    fn next_context_index(&self) -> Option<usize> {
        let current_index = self.context_cursor?;
        match self.mode {
            PlaybackMode::Sequential | PlaybackMode::RepeatOne => {
                (current_index + 1 < self.context.len()).then_some(current_index + 1)
            }
            PlaybackMode::RepeatAll => Some((current_index + 1) % self.context.len()),
            PlaybackMode::Shuffle => {
                let cursor = self.shuffle_cursor?;
                if cursor + 1 < self.shuffle_order.len() {
                    Some(self.shuffle_order[cursor + 1])
                } else {
                    self.shuffle_order.first().copied()
                }
            }
        }
    }

    fn rebuild_shuffle(&mut self) {
        self.shuffle_order = (0..self.context.len()).collect();
        let mut state = self.shuffle_seed ^ (self.context.len() as u64).wrapping_mul(0x9E37_79B9);
        for index in (1..self.shuffle_order.len()).rev() {
            state = splitmix64(state);
            self.shuffle_order.swap(index, state as usize % (index + 1));
        }
        if let Some(current_index) = self.context_cursor {
            if let Some(position) = self
                .shuffle_order
                .iter()
                .position(|candidate| *candidate == current_index)
            {
                self.shuffle_order.rotate_left(position);
                self.shuffle_cursor = Some(0);
            }
        }
    }
}

fn move_vec_deque<T>(values: &mut VecDeque<T>, from: usize, to: usize) -> bool {
    if from >= values.len() || to >= values.len() || from == to {
        return from == to && from < values.len();
    }
    let Some(value) = values.remove(from) else {
        return false;
    };
    values.insert(to, value);
    true
}

fn remap_index_after_move(index: usize, from: usize, to: usize) -> usize {
    if index == from {
        to
    } else if from < index && index <= to {
        index - 1
    } else if to <= index && index < from {
        index + 1
    } else {
        index
    }
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::test_item;

    #[test]
    fn priority_items_precede_context_and_are_consumed() {
        let mut queue = PlaybackQueue::new(1);
        assert!(queue.replace_context(vec![test_item(1), test_item(2)], 0));
        queue.play_next(test_item(9));

        assert_eq!(queue.advance(false).unwrap().queue_id, 9);
        assert!(queue.priority().is_empty());
        assert_eq!(queue.advance(false).unwrap().queue_id, 2);
    }

    #[test]
    fn repeat_one_only_applies_to_automatic_advance() {
        let mut queue = PlaybackQueue::new(1);
        queue.replace_context(vec![test_item(1), test_item(2)], 0);
        queue.set_mode(PlaybackMode::RepeatOne);

        assert_eq!(queue.advance(true).unwrap().queue_id, 1);
        assert_eq!(queue.advance(false).unwrap().queue_id, 2);
    }

    #[test]
    fn shuffle_is_stable_and_previous_uses_history() {
        let items: Vec<_> = (1..=6).map(test_item).collect();
        let mut first = PlaybackQueue::new(42);
        let mut second = PlaybackQueue::new(42);
        first.replace_context(items.clone(), 0);
        second.replace_context(items, 0);
        first.set_mode(PlaybackMode::Shuffle);
        second.set_mode(PlaybackMode::Shuffle);

        let first_next = first.advance(false).unwrap().clone();
        let second_next = second.advance(false).unwrap().clone();
        assert_eq!(first_next, second_next);
        assert_eq!(first.previous().unwrap().queue_id, 1);
    }

    #[test]
    fn modes_cycle_in_product_order() {
        let mut queue = PlaybackQueue::new(0);
        assert_eq!(queue.cycle_mode(), PlaybackMode::RepeatAll);
        assert_eq!(queue.cycle_mode(), PlaybackMode::RepeatOne);
        assert_eq!(queue.cycle_mode(), PlaybackMode::Shuffle);
        assert_eq!(queue.cycle_mode(), PlaybackMode::Sequential);
    }

    #[test]
    fn remove_reorder_and_section_clear_preserve_queue_invariants() {
        let mut queue = PlaybackQueue::new(7);
        queue.replace_context(vec![test_item(1), test_item(2), test_item(3)], 1);
        queue.play_next(test_item(8));
        queue.play_next(test_item(9));

        assert!(queue.reorder(QueueSection::Priority, 1, 0));
        assert_eq!(queue.priority()[0].queue_id, 9);
        assert!(queue.reorder(QueueSection::Context, 0, 2));
        assert_eq!(queue.current().unwrap().queue_id, 2);
        assert_eq!(queue.context_cursor, Some(0));
        assert_eq!(queue.remove(3).unwrap().queue_id, 3);
        assert_eq!(queue.remove(2).unwrap().queue_id, 2);
        assert_eq!(queue.current().unwrap().queue_id, 1);
        assert_eq!(queue.context_cursor, Some(0));

        queue.clear_priority();
        assert!(queue.priority().is_empty());
        assert!(!queue.context().is_empty());
        queue.clear_context();
        assert!(queue.current().is_none());
        assert!(queue.context().is_empty());
    }

    #[test]
    fn context_snapshot_round_trips_traversal_history() {
        let mut queue = PlaybackQueue::new(42);
        queue.replace_context(vec![test_item(1), test_item(2), test_item(3)], 0);
        queue.advance(false);
        queue.play_next(test_item(9));
        let snapshot = queue.context_snapshot();

        let mut restored = PlaybackQueue::restore(snapshot.clone()).unwrap();
        assert_eq!(restored.context_snapshot(), snapshot);
        assert_eq!(restored.previous().unwrap().queue_id, 1);
    }
}
