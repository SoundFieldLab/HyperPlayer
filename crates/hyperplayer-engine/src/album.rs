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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlbumFillItemState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlbumFillItemPriority {
    Deferred,
    Standard,
}

impl AlbumFillItemPriority {
    pub fn rank(self) -> u8 {
        match self {
            Self::Deferred => 0,
            Self::Standard => 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlbumFillWorkAvailability {
    Idle,
    ForegroundPending,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumFillItem {
    pub item_id: i64,
    pub album_id: String,
    pub content_id: crate::model::MediaId,
    pub quality: String,
    pub state: AlbumFillItemState,
    pub attempt_count: u32,
    pub priority: AlbumFillItemPriority,
    pub created_unix_ms: u64,
    pub updated_unix_ms: u64,
    pub failure: Option<String>,
}

impl AlbumFillItem {
    pub fn pending(
        album_id: impl Into<String>,
        content_id: crate::model::MediaId,
        quality: impl Into<String>,
        priority: AlbumFillItemPriority,
        created_unix_ms: u64,
    ) -> Self {
        Self {
            item_id: 0,
            album_id: album_id.into(),
            content_id,
            quality: quality.into(),
            state: AlbumFillItemState::Pending,
            attempt_count: 0,
            priority,
            created_unix_ms,
            updated_unix_ms: created_unix_ms,
            failure: None,
        }
    }
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
    IdleResourcePolicy.allow_album_fill(conditions)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AlbumFillPoll {
    Claimed(AlbumFillItem),
    YieldedToForeground,
    BlockedResources,
    Idle,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AlbumFillCoordinator {
    policy: IdleResourcePolicy,
}

impl AlbumFillCoordinator {
    pub fn poll(
        &self,
        repository: &mut crate::repository::SqliteRepository,
        conditions: &ResourceConditions,
        availability: AlbumFillWorkAvailability,
        updated_unix_ms: u64,
    ) -> crate::Result<AlbumFillPoll> {
        if availability == AlbumFillWorkAvailability::ForegroundPending {
            repository.yield_album_fill_items(updated_unix_ms)?;
            return Ok(AlbumFillPoll::YieldedToForeground);
        }
        if !self.policy.allow_album_fill(conditions) {
            repository.yield_album_fill_items(updated_unix_ms)?;
            return Ok(AlbumFillPoll::BlockedResources);
        }
        Ok(repository
            .claim_album_fill_item(updated_unix_ms, availability)?
            .map(AlbumFillPoll::Claimed)
            .unwrap_or(AlbumFillPoll::Idle))
    }
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
    fn d30_default_allows_only_idle_resources() {
        let conditions = idle_conditions();
        assert!(may_fill_frequent_album(&conditions));
        let mut blocked = conditions.clone();
        blocked.metered_network = true;
        assert!(!may_fill_frequent_album(&blocked));
        blocked = conditions.clone();
        blocked.low_battery = true;
        assert!(!may_fill_frequent_album(&blocked));
        blocked = conditions.clone();
        blocked.disk_pressure = true;
        assert!(!may_fill_frequent_album(&blocked));
    }

    #[test]
    fn coordinator_claims_when_idle_and_yields_running_work_to_foreground() {
        let root = tempfile::tempdir().unwrap();
        let mut repository =
            crate::repository::SqliteRepository::open(root.path().join("album.db")).unwrap();
        let item = AlbumFillItem::pending(
            "album",
            crate::model::MediaId::new("song"),
            "standard",
            AlbumFillItemPriority::Standard,
            1,
        );
        repository.enqueue_album_fill_item(&item).unwrap();
        let coordinator = AlbumFillCoordinator::default();
        let claimed = coordinator
            .poll(
                &mut repository,
                &idle_conditions(),
                AlbumFillWorkAvailability::Idle,
                2,
            )
            .unwrap();
        let AlbumFillPoll::Claimed(claimed) = claimed else {
            panic!("idle coordinator must claim work");
        };
        assert_eq!(claimed.state, AlbumFillItemState::Running);
        assert_eq!(
            coordinator
                .poll(
                    &mut repository,
                    &idle_conditions(),
                    AlbumFillWorkAvailability::ForegroundPending,
                    3,
                )
                .unwrap(),
            AlbumFillPoll::YieldedToForeground
        );
        assert_eq!(
            repository
                .album_fill_item(claimed.item_id)
                .unwrap()
                .unwrap()
                .state,
            AlbumFillItemState::Pending
        );
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
