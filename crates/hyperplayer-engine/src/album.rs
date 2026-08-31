use serde::{Deserialize, Serialize};

pub const QUALIFYING_PLAYBACK_MS: u64 = 5 * 60 * 1_000;
pub const FREQUENT_ALBUM_THRESHOLD: u32 = 5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumSession {
    pub album_id: String,
    pub local_day: String,
    pub from_album_context: bool,
    pub completed_tracks: u32,
    pub effective_playback_ms: u64,
}

impl AlbumSession {
    pub fn qualifies(&self) -> bool {
        self.from_album_context
            && (self.completed_tracks >= 1 || self.effective_playback_ms >= QUALIFYING_PLAYBACK_MS)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlbumPromotion {
    pub counted: bool,
    pub qualified_sessions: u32,
    pub became_frequent: bool,
    pub is_frequent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefetchPriority {
    CurrentTrack,
    NextTrack,
    FollowingTrack,
    FrequentAlbumRemainder,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlbumTaskState {
    Pending,
    Running,
    PausedResources,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumFillTask {
    pub album_id: String,
    pub state: AlbumTaskState,
    pub priority: PrefetchPriority,
    pub completed_items: u32,
    pub total_items: u32,
    pub updated_unix_ms: u64,
    pub failure: Option<String>,
}

impl AlbumFillTask {
    pub fn transition(&mut self, next: AlbumTaskState, updated_unix_ms: u64) -> bool {
        let allowed = matches!(
            (self.state, next),
            (AlbumTaskState::Pending, AlbumTaskState::Running)
                | (AlbumTaskState::Pending, AlbumTaskState::Cancelled)
                | (AlbumTaskState::Running, AlbumTaskState::PausedResources)
                | (AlbumTaskState::Running, AlbumTaskState::Completed)
                | (AlbumTaskState::Running, AlbumTaskState::Cancelled)
                | (AlbumTaskState::Running, AlbumTaskState::Failed)
                | (AlbumTaskState::PausedResources, AlbumTaskState::Running)
                | (AlbumTaskState::PausedResources, AlbumTaskState::Cancelled)
                | (AlbumTaskState::PausedResources, AlbumTaskState::Failed)
        );
        if allowed {
            self.state = next;
            self.updated_unix_ms = updated_unix_ms;
            if next != AlbumTaskState::Failed {
                self.failure = None;
            }
        }
        allowed
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceConditions {
    pub pipeline_idle: bool,
    pub network_idle: bool,
    pub metered_network: bool,
    pub low_battery: bool,
    pub disk_pressure: bool,
}

pub trait BackgroundFillPolicy: Send + Sync {
    fn allow_album_fill(&self, conditions: &ResourceConditions) -> bool;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BackgroundFillDisabled;

impl BackgroundFillPolicy for BackgroundFillDisabled {
    fn allow_album_fill(&self, _conditions: &ResourceConditions) -> bool {
        false
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct IdleResourcePolicy;

impl BackgroundFillPolicy for IdleResourcePolicy {
    fn allow_album_fill(&self, conditions: &ResourceConditions) -> bool {
        conditions.pipeline_idle
            && conditions.network_idle
            && !conditions.metered_network
            && !conditions.low_battery
            && !conditions.disk_pressure
    }
}

pub fn may_fill_frequent_album(conditions: &ResourceConditions) -> bool {
    BackgroundFillDisabled.allow_album_fill(conditions)
}

pub fn album_context_prefetch_enabled(from_album_context: bool) -> bool {
    from_album_context
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle_conditions() -> ResourceConditions {
        ResourceConditions {
            pipeline_idle: true,
            network_idle: true,
            metered_network: false,
            low_battery: false,
            disk_pressure: false,
        }
    }

    #[test]
    fn session_requires_album_context_and_one_threshold() {
        let mut session = AlbumSession {
            album_id: "album".into(),
            local_day: "2026-08-30".into(),
            from_album_context: false,
            completed_tracks: 1,
            effective_playback_ms: 0,
        };
        assert!(!session.qualifies());
        session.from_album_context = true;
        assert!(session.qualifies());
        session.completed_tracks = 0;
        session.effective_playback_ms = QUALIFYING_PLAYBACK_MS;
        assert!(session.qualifies());
    }

    #[test]
    fn d25_default_disables_background_fill() {
        let conditions = idle_conditions();
        assert!(!may_fill_frequent_album(&conditions));
        assert!(IdleResourcePolicy.allow_album_fill(&conditions));
    }

    #[test]
    fn task_state_machine_rejects_terminal_restart() {
        let mut task = AlbumFillTask {
            album_id: "album".into(),
            state: AlbumTaskState::Pending,
            priority: PrefetchPriority::FrequentAlbumRemainder,
            completed_items: 0,
            total_items: 10,
            updated_unix_ms: 1,
            failure: None,
        };
        assert!(task.transition(AlbumTaskState::Running, 2));
        assert!(task.transition(AlbumTaskState::Completed, 3));
        assert!(!task.transition(AlbumTaskState::Running, 4));
    }
}
