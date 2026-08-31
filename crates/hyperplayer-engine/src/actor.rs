use crate::audio::{AudioOutput, CpalAudioOutput, DecoderFactory, LocalDecoderFactory};
use crate::error::{EngineError, Result};
use crate::media::TrustedResolvedMedia;
use crate::model::QueueItem;
use crate::playback::{PlaybackMachine, PlaybackSnapshot, PlaybackState};
use crate::queue::{
    PlaybackMode, PlaybackQueue, QueueContextSnapshot, QueueInsertPosition, QueueSection,
};
use crate::runtime::{PumpResult, RuntimeCoordinator};
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const ACTOR_TICK: Duration = Duration::from_millis(5);
const STANDBY_FRAMES: usize = 4096;

pub enum EngineCommand {
    LoadContext {
        items: Vec<QueueItem>,
        start_index: usize,
        media: TrustedResolvedMedia,
    },
    Ready,
    Pause,
    Resume,
    Seek(u64),
    SetVolume(f32),
    Stop,
    Next {
        automatic: bool,
        expected_queue_id: u64,
    },
    Previous {
        expected_queue_id: u64,
    },
    PlayNext {
        item: QueueItem,
        media: TrustedResolvedMedia,
    },
    Enqueue {
        item: QueueItem,
        position: QueueInsertPosition,
        media: TrustedResolvedMedia,
    },
    Remove {
        queue_id: u64,
    },
    Reorder {
        queue_id: u64,
        target_index: usize,
    },
    ClearPriority,
    ClearAll,
    RestoreQueue {
        snapshot: QueueContextSnapshot,
        position_ms: u64,
        resume: bool,
    },
    AttachResolvedMedia {
        media: Vec<(u64, TrustedResolvedMedia)>,
    },
    SetMode(PlaybackMode),
    Snapshot,
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineEventKind {
    Progress,
    StateChanged,
    AutomaticTransitionRequested,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineEvent {
    pub kind: EngineEventKind,
    pub snapshot: PlaybackSnapshot,
}

type Envelope = (EngineCommand, SyncSender<Result<PlaybackSnapshot>>);
type OutputFactory = Box<dyn FnMut(crate::dsp::PcmFormat) -> Result<Box<dyn AudioOutput>> + Send>;

struct EngineRuntime {
    machine: PlaybackMachine,
    audio: Option<RuntimeCoordinator>,
    decoder_factory: Option<Box<dyn DecoderFactory>>,
    output_factory: Option<OutputFactory>,
    subscribers: Vec<SyncSender<EngineEvent>>,
    media: HashMap<u64, TrustedResolvedMedia>,
    pending_restore: bool,
}

pub struct EngineHandle {
    sender: SyncSender<Envelope>,
    event_sender: SyncSender<SyncSender<EngineEvent>>,
    worker: Option<JoinHandle<()>>,
}

impl EngineHandle {
    pub fn spawn(capacity: usize, shuffle_seed: u64) -> Result<Self> {
        Self::spawn_with(
            capacity,
            shuffle_seed,
            Box::new(LocalDecoderFactory),
            Box::new(|format| Ok(Box::new(CpalAudioOutput::open(format, 16_384)?))),
        )
    }

    pub fn spawn_with_output(
        capacity: usize,
        shuffle_seed: u64,
        decoder_factory: Box<dyn DecoderFactory>,
        output: Box<dyn AudioOutput>,
    ) -> Result<Self> {
        let mut output = Some(output);
        Self::spawn_with(
            capacity,
            shuffle_seed,
            decoder_factory,
            Box::new(move |_format| {
                output
                    .take()
                    .ok_or_else(|| EngineError::AudioBackend("test output already opened".into()))
            }),
        )
    }

    fn spawn_with(
        capacity: usize,
        shuffle_seed: u64,
        decoder_factory: Box<dyn DecoderFactory>,
        output_factory: OutputFactory,
    ) -> Result<Self> {
        if capacity == 0 {
            return Err(EngineError::InvalidInput(
                "actor capacity must be greater than zero".into(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let (event_sender, event_receiver) = mpsc::sync_channel(capacity);
        let worker = thread::Builder::new()
            .name("hyperplayer-engine".into())
            .spawn(move || {
                run_actor(
                    receiver,
                    event_receiver,
                    PlaybackMachine::new(shuffle_seed),
                    decoder_factory,
                    output_factory,
                )
            })?;
        Ok(Self {
            sender,
            event_sender,
            worker: Some(worker),
        })
    }

    pub fn request(&self, command: EngineCommand) -> Result<PlaybackSnapshot> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        match self.sender.try_send((command, reply_tx)) {
            Ok(()) => reply_rx
                .recv()
                .map_err(|_| EngineError::ActorResponseClosed)?,
            Err(TrySendError::Full(_)) => Err(EngineError::ActorQueueFull),
            Err(TrySendError::Disconnected(_)) => Err(EngineError::ActorUnavailable),
        }
    }

    pub fn snapshot(&self) -> Result<PlaybackSnapshot> {
        self.request(EngineCommand::Snapshot)
    }

    pub fn subscribe_events(&self, capacity: usize) -> Result<Receiver<EngineEvent>> {
        if capacity == 0 {
            return Err(EngineError::InvalidInput(
                "event subscription capacity must be greater than zero".into(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(capacity);
        self.event_sender
            .try_send(sender)
            .map_err(|error| match error {
                TrySendError::Full(_) => EngineError::ActorQueueFull,
                TrySendError::Disconnected(_) => EngineError::ActorUnavailable,
            })?;
        Ok(receiver)
    }

    pub fn shutdown(mut self) -> Result<()> {
        let _ = self.request(EngineCommand::Shutdown)?;
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| EngineError::ActorUnavailable)?;
        }
        Ok(())
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            let (reply_tx, _reply_rx) = mpsc::sync_channel(1);
            let _ = self.sender.send((EngineCommand::Shutdown, reply_tx));
            let _ = worker.join();
        }
    }
}

fn run_actor(
    receiver: Receiver<Envelope>,
    event_receiver: Receiver<SyncSender<EngineEvent>>,
    machine: PlaybackMachine,
    decoder_factory: Box<dyn DecoderFactory>,
    output_factory: OutputFactory,
) {
    let mut engine = EngineRuntime {
        machine,
        audio: None,
        decoder_factory: Some(decoder_factory),
        output_factory: Some(output_factory),
        subscribers: Vec::new(),
        media: HashMap::new(),
        pending_restore: false,
    };
    loop {
        while let Ok(subscriber) = event_receiver.try_recv() {
            engine.subscribers.push(subscriber);
        }
        match receiver.recv_timeout(ACTOR_TICK) {
            Ok((command, reply)) => {
                let shutdown = matches!(command, EngineCommand::Shutdown);
                let result = apply(&mut engine, command).map(|()| engine.machine.snapshot());
                let _ = reply.send(result);
                if shutdown {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if matches!(engine.machine.state(), PlaybackState::Playing { .. }) {
                    if let Some(runtime) = engine.audio.as_mut() {
                        match runtime.pump_once() {
                            Ok(PumpResult::Progress { position_ms }) => {
                                if engine.machine.update_position(position_ms).is_ok() {
                                    publish(
                                        &mut engine.subscribers,
                                        EngineEventKind::Progress,
                                        engine.machine.snapshot(),
                                    );
                                }
                            }
                            Ok(PumpResult::Pending) => {}
                            Ok(PumpResult::Eof { output_drained }) => {
                                if engine.machine.queue().peek_next(true).is_some() {
                                    let expected_queue_id = engine
                                        .machine
                                        .queue()
                                        .peek_next(true)
                                        .expect("checked next queue item")
                                        .queue_id;
                                    let needs_hydration = automatic_transition_needs_hydration(
                                        &engine.machine,
                                        &engine.media,
                                    );
                                    let kind = if needs_hydration {
                                        let _ = runtime.pause();
                                        let _ = engine.machine.pause();
                                        EngineEventKind::AutomaticTransitionRequested
                                    } else {
                                        let prior = engine.machine.state().clone();
                                        match advance_and_start(
                                            &mut engine.machine,
                                            runtime,
                                            &engine.media,
                                            true,
                                            expected_queue_id,
                                        ) {
                                            Ok(()) => EngineEventKind::StateChanged,
                                            Err(_) => {
                                                restore_current_runtime(
                                                    &mut engine.machine,
                                                    runtime,
                                                    &engine.media,
                                                    &prior,
                                                );
                                                EngineEventKind::AutomaticTransitionRequested
                                            }
                                        }
                                    };
                                    publish(
                                        &mut engine.subscribers,
                                        kind,
                                        engine.machine.snapshot(),
                                    );
                                } else if output_drained {
                                    let _ = runtime.stop();
                                    let _ = engine.machine.stop();
                                    publish(
                                        &mut engine.subscribers,
                                        EngineEventKind::StateChanged,
                                        engine.machine.snapshot(),
                                    );
                                }
                            }
                            Err(error) => {
                                let _ = runtime.stop();
                                engine.machine.fail(error.to_string());
                                publish(
                                    &mut engine.subscribers,
                                    EngineEventKind::StateChanged,
                                    engine.machine.snapshot(),
                                );
                            }
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn apply(engine: &mut EngineRuntime, command: EngineCommand) -> Result<()> {
    let machine = &mut engine.machine;
    let runtime = &mut engine.audio;
    match command {
        EngineCommand::LoadContext {
            items,
            start_index,
            media,
        } => {
            engine.pending_restore = false;
            machine.load_context(items, start_index)?;
            let item = machine
                .state()
                .current()
                .expect("loaded context has current")
                .clone();
            if item.track != media.track {
                machine.fail("resolved media does not match the loaded track");
                return Err(EngineError::InvalidInput(
                    "resolved media does not match the loaded track".into(),
                ));
            }
            engine.media.clear();
            engine.media.insert(item.queue_id, media.clone());
            if runtime.is_none() {
                let factory = engine
                    .decoder_factory
                    .take()
                    .ok_or(EngineError::ActorUnavailable)?;
                let probe = factory.open(&media)?;
                let output = engine
                    .output_factory
                    .as_mut()
                    .ok_or(EngineError::ActorUnavailable)?(
                    probe.descriptor().format
                )?;
                engine.output_factory = None;
                *runtime = Some(RuntimeCoordinator::new(factory, output));
            }
            if let Err(error) = runtime.as_mut().unwrap().load(&media) {
                machine.fail(error.to_string());
                return Err(error);
            }
            prime_next(machine, runtime.as_mut().unwrap(), &engine.media);
            Ok(())
        }
        EngineCommand::Ready => {
            runtime_mut(runtime)?.start()?;
            machine.ready()
        }
        EngineCommand::Pause => {
            runtime_mut(runtime)?.pause()?;
            machine.pause()
        }
        EngineCommand::Resume => {
            if engine.pending_restore {
                start_restored(engine)
            } else {
                runtime_mut(&mut engine.audio)?.resume()?;
                engine.machine.resume()
            }
        }
        EngineCommand::Seek(position_ms) => {
            let actual = runtime_mut(runtime)?.seek(position_ms)?;
            machine.seek(actual)
        }
        EngineCommand::SetVolume(volume) => runtime_mut(runtime)?.set_volume(volume),
        EngineCommand::Stop => {
            runtime_mut(runtime)?.stop()?;
            machine.stop()
        }
        EngineCommand::Next {
            automatic,
            expected_queue_id,
        } => transition_next(engine, automatic, expected_queue_id),
        EngineCommand::Previous { expected_queue_id } => {
            transition_previous(engine, expected_queue_id)
        }
        EngineCommand::PlayNext { item, media } => {
            if item.track != media.track {
                return Err(EngineError::InvalidInput(
                    "resolved media does not match the queued track".into(),
                ));
            }
            engine.media.insert(item.queue_id, media);
            machine.play_next(item);
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::Enqueue {
            item,
            position,
            media,
        } => {
            if item.track != media.track {
                return Err(EngineError::InvalidInput(
                    "resolved media does not match the queued track".into(),
                ));
            }
            engine.media.insert(item.queue_id, media);
            machine.enqueue(item, position);
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::Remove { queue_id } => {
            let current_changed = machine.remove(queue_id)?;
            engine.media.remove(&queue_id);
            if current_changed {
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop()?;
                }
            }
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::Reorder {
            queue_id,
            target_index,
        } => {
            let (section, from) = machine
                .queue()
                .priority()
                .iter()
                .position(|item| item.queue_id == queue_id)
                .map(|index| (QueueSection::Priority, index))
                .or_else(|| {
                    machine
                        .queue()
                        .context()
                        .iter()
                        .position(|item| item.queue_id == queue_id)
                        .map(|index| (QueueSection::Context, index))
                })
                .ok_or_else(|| {
                    EngineError::InvalidInput(format!("queue item does not exist: {queue_id}"))
                })?;
            machine.reorder(section, from, target_index)?;
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::ClearPriority => {
            machine.clear_priority();
            retain_queued_media(machine, &mut engine.media);
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::ClearAll => {
            if machine.clear_all() {
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop()?;
                }
            }
            engine.media.clear();
            Ok(())
        }
        EngineCommand::RestoreQueue {
            snapshot,
            position_ms,
            resume,
        } => {
            let queue = PlaybackQueue::restore(snapshot).ok_or_else(|| {
                EngineError::InvalidInput("invalid queue context snapshot".into())
            })?;
            if let Some(runtime) = runtime.as_mut() {
                runtime.stop()?;
            }
            engine.media.clear();
            machine.restore_queue(queue, position_ms);
            engine.pending_restore = machine.state().current().is_some();
            if !resume || !engine.pending_restore {
                return Ok(());
            }
            start_restored(engine)
        }
        EngineCommand::AttachResolvedMedia { media } => {
            for (queue_id, resolved) in &media {
                let item = find_queue_item(machine, *queue_id).ok_or_else(|| {
                    EngineError::InvalidInput(format!("queue item does not exist: {queue_id}"))
                })?;
                if item.track.id != resolved.track.id
                    || !same_media_source(&item.track.source, &resolved.track.source)
                {
                    return Err(EngineError::InvalidInput(
                        "resolved media does not match the restored queue track".into(),
                    ));
                }
            }
            engine
                .media
                .extend(media.into_iter().map(|(queue_id, resolved)| {
                    let track = find_queue_item(machine, queue_id)
                        .expect("attached queue item was validated")
                        .track
                        .clone();
                    (queue_id, TrustedResolvedMedia::new(track, resolved.handle))
                }));
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::SetMode(mode) => {
            machine.set_mode(mode);
            if let Some(runtime) = runtime.as_mut() {
                prime_next(machine, runtime, &engine.media);
            }
            Ok(())
        }
        EngineCommand::Snapshot => Ok(()),
        EngineCommand::Shutdown => {
            if let Some(runtime) = runtime.as_mut() {
                runtime.stop()?;
            }
            Ok(())
        }
    }
}

fn start_restored(engine: &mut EngineRuntime) -> Result<()> {
    let (item, position_ms) = match engine.machine.state() {
        PlaybackState::Paused { item, position_ms } => (item.clone(), *position_ms),
        state => {
            return Err(EngineError::InvalidTransition {
                from: state.name(),
                command: "resume restored playback",
            })
        }
    };
    let resolved = engine.media.get(&item.queue_id).ok_or_else(|| {
        EngineError::InvalidInput("restored queue media must be resolved before playback".into())
    })?;
    if engine.audio.is_none() {
        let factory = engine
            .decoder_factory
            .take()
            .ok_or(EngineError::ActorUnavailable)?;
        let probe = factory.open(resolved)?;
        let output = engine
            .output_factory
            .as_mut()
            .ok_or(EngineError::ActorUnavailable)?(probe.descriptor().format)?;
        engine.output_factory = None;
        engine.audio = Some(RuntimeCoordinator::new(factory, output));
    }
    let runtime = engine.audio.as_mut().expect("audio runtime initialized");
    runtime.load(resolved)?;
    let actual_position_ms = runtime.seek(position_ms)?;
    runtime.start()?;
    engine.machine.seek(actual_position_ms)?;
    engine.machine.resume()?;
    engine.pending_restore = false;
    prime_next(&engine.machine, runtime, &engine.media);
    Ok(())
}

fn same_media_source(left: &crate::model::MediaSource, right: &crate::model::MediaSource) -> bool {
    matches!(
        (left, right),
        (
            crate::model::MediaSource::Local { .. },
            crate::model::MediaSource::Local { .. }
        )
    ) || matches!(
        (left, right),
        (
            crate::model::MediaSource::Netease { song_id: left },
            crate::model::MediaSource::Netease { song_id: right }
        ) if left == right
    )
}

fn find_queue_item(machine: &PlaybackMachine, queue_id: u64) -> Option<&QueueItem> {
    machine
        .queue()
        .current()
        .into_iter()
        .chain(machine.queue().priority().iter())
        .chain(machine.queue().context().iter())
        .chain(machine.queue().traversal_history().iter())
        .find(|item| item.queue_id == queue_id)
}

fn transition_next(
    engine: &mut EngineRuntime,
    automatic: bool,
    expected_queue_id: u64,
) -> Result<()> {
    let target = engine
        .machine
        .queue()
        .peek_next(automatic)
        .ok_or_else(|| EngineError::InvalidInput("queue has no next item".into()))?;
    if target.queue_id != expected_queue_id {
        return Err(EngineError::InvalidInput(
            "queue transition target changed before playback".into(),
        ));
    }
    let target = target.clone();
    prepare_transition(engine, &target)?;
    engine.machine.next(automatic)?;
    engine.machine.ready()?;
    prime_next(
        &engine.machine,
        runtime_mut(&mut engine.audio)?,
        &engine.media,
    );
    Ok(())
}

fn transition_previous(engine: &mut EngineRuntime, expected_queue_id: u64) -> Result<()> {
    let target = previous_target(&engine.machine, &engine.media, expected_queue_id)?.clone();
    prepare_transition(engine, &target)?;
    engine.machine.previous()?;
    engine.machine.ready()?;
    prime_next(
        &engine.machine,
        runtime_mut(&mut engine.audio)?,
        &engine.media,
    );
    Ok(())
}

fn prepare_transition(engine: &mut EngineRuntime, target: &QueueItem) -> Result<()> {
    let prior = engine.machine.state().clone();
    let result = prepare_target(runtime_mut(&mut engine.audio)?, &engine.media, target);
    if let Err(error) = result {
        restore_current_after_transition_failure(engine, &prior);
        return Err(error);
    }
    Ok(())
}

fn restore_current_after_transition_failure(engine: &mut EngineRuntime, prior: &PlaybackState) {
    let Some(runtime) = engine.audio.as_mut() else {
        return;
    };
    restore_current_runtime(&mut engine.machine, runtime, &engine.media, prior);
}

fn restore_current_runtime(
    machine: &mut PlaybackMachine,
    runtime: &mut RuntimeCoordinator,
    media: &HashMap<u64, TrustedResolvedMedia>,
    prior: &PlaybackState,
) {
    let Some(current) = prior.current() else {
        return;
    };
    let Some(current_media) = media.get(&current.queue_id) else {
        return;
    };
    let position_ms = match prior {
        PlaybackState::Playing { position_ms, .. } | PlaybackState::Paused { position_ms, .. } => {
            *position_ms
        }
        _ => 0,
    };
    if runtime.load(current_media).is_ok() {
        let actual = runtime.seek(position_ms).unwrap_or(position_ms);
        if matches!(prior, PlaybackState::Playing { .. }) {
            let _ = machine.pause();
        }
        let _ = machine.seek(actual);
        prime_next(machine, runtime, media);
    }
}

fn automatic_transition_needs_hydration(
    machine: &PlaybackMachine,
    media: &HashMap<u64, TrustedResolvedMedia>,
) -> bool {
    let Some(target) = machine.queue().peek_next(true) else {
        return false;
    };
    if !media.contains_key(&target.queue_id) {
        return true;
    }
    let mut queue = machine.queue().clone();
    queue.advance(true);
    queue
        .peek_next(true)
        .is_some_and(|following| !media.contains_key(&following.queue_id))
}

fn advance_and_start(
    machine: &mut PlaybackMachine,
    runtime: &mut RuntimeCoordinator,
    media: &HashMap<u64, TrustedResolvedMedia>,
    automatic: bool,
    expected_queue_id: u64,
) -> Result<()> {
    let target = machine
        .queue()
        .peek_next(automatic)
        .ok_or_else(|| EngineError::InvalidInput("queue has no next item".into()))?;
    if target.queue_id != expected_queue_id {
        return Err(EngineError::InvalidInput(
            "queue transition target changed before playback".into(),
        ));
    }
    prepare_target(runtime, media, target)?;
    machine.next(automatic)?;
    machine.ready()?;
    prime_next(machine, runtime, media);
    Ok(())
}

fn previous_target<'a>(
    machine: &'a PlaybackMachine,
    media: &HashMap<u64, TrustedResolvedMedia>,
    expected_queue_id: u64,
) -> Result<&'a QueueItem> {
    let target = machine
        .queue()
        .traversal_history()
        .last()
        .ok_or_else(|| EngineError::InvalidInput("playback history is empty".into()))?;
    if target.queue_id != expected_queue_id || !media.contains_key(&target.queue_id) {
        return Err(EngineError::InvalidInput(
            "previous queue media must be resolved before playback".into(),
        ));
    }
    Ok(target)
}

fn prepare_target(
    runtime: &mut RuntimeCoordinator,
    media: &HashMap<u64, TrustedResolvedMedia>,
    item: &QueueItem,
) -> Result<()> {
    let resolved = media.get(&item.queue_id).ok_or_else(|| {
        EngineError::InvalidInput("queue media must be resolved before playback".into())
    })?;
    let promoted = runtime.promote_standby(&item.track)?;
    if !promoted {
        runtime.load(resolved)?;
    }
    runtime.start().map(|_| ())
}

fn prime_next(
    machine: &PlaybackMachine,
    runtime: &mut RuntimeCoordinator,
    media: &HashMap<u64, TrustedResolvedMedia>,
) {
    let next = machine
        .queue()
        .peek_next(true)
        .and_then(|next| media.get(&next.queue_id));
    if let Some(resolved) = next {
        let _ = runtime.prime_standby(resolved, STANDBY_FRAMES);
    } else if runtime.standby().is_gapless_ready() {
        let _ = runtime.take_standby_at_sample_boundary();
    }
}

fn retain_queued_media(machine: &PlaybackMachine, media: &mut HashMap<u64, TrustedResolvedMedia>) {
    media.retain(|queue_id, _| {
        machine
            .queue()
            .priority()
            .iter()
            .chain(machine.queue().context().iter())
            .any(|item| item.queue_id == *queue_id)
    });
}

fn runtime_mut(runtime: &mut Option<RuntimeCoordinator>) -> Result<&mut RuntimeCoordinator> {
    runtime
        .as_mut()
        .ok_or_else(|| EngineError::InvalidInput("no playback context is loaded".into()))
}

fn publish(
    subscribers: &mut Vec<SyncSender<EngineEvent>>,
    kind: EngineEventKind,
    snapshot: PlaybackSnapshot,
) {
    let event = EngineEvent { kind, snapshot };
    subscribers.retain(|subscriber| match subscriber.try_send(event.clone()) {
        Ok(()) | Err(TrySendError::Full(_)) => true,
        Err(TrySendError::Disconnected(_)) => false,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{StandbyState, WavDecoderFactory};
    use crate::dsp::{PcmFormat, PcmSampleFormat};
    use crate::model::{MediaId, MediaSource, Track};
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    #[derive(Default)]
    struct State {
        events: Vec<&'static str>,
        samples: Vec<f32>,
    }
    struct TestOutput {
        format: PcmFormat,
        state: Arc<Mutex<State>>,
        fail_start: bool,
    }
    impl AudioOutput for TestOutput {
        fn format(&self) -> PcmFormat {
            self.format
        }
        fn start(&mut self) -> Result<()> {
            self.state.lock().unwrap().events.push("start");
            if self.fail_start {
                return Err(EngineError::AudioBackend("start failed".into()));
            }
            Ok(())
        }
        fn pause(&mut self) -> Result<()> {
            self.state.lock().unwrap().events.push("pause");
            Ok(())
        }
        fn stop(&mut self) -> Result<()> {
            self.state.lock().unwrap().events.push("stop");
            Ok(())
        }
        fn write(&mut self, pcm: &[f32]) -> Result<usize> {
            self.state.lock().unwrap().samples.extend_from_slice(pcm);
            Ok(pcm.len())
        }
        fn set_volume(&mut self, volume: f32) -> Result<()> {
            if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
                return Err(EngineError::InvalidInput("invalid test volume".into()));
            }
            self.state.lock().unwrap().events.push("volume");
            Ok(())
        }
    }
    fn format() -> PcmFormat {
        PcmFormat {
            sample_rate: 1_000,
            channels: 1,
            sample_format: PcmSampleFormat::F32,
        }
    }
    fn item(id: u64, path: &Path) -> QueueItem {
        QueueItem::new(
            id,
            Track {
                id: MediaId::new(format!("track-{id}")),
                source: MediaSource::Local {
                    path: path.to_path_buf(),
                },
                title: format!("Track {id}"),
                artists: vec![],
                album: None,
                album_id: None,
                artist_ids: vec![],
                artwork_hash: None,
                artwork_mime: None,
                duration_ms: None,
            },
        )
    }
    fn media(item: &QueueItem, path: &Path) -> TrustedResolvedMedia {
        TrustedResolvedMedia::new(
            item.track.clone(),
            crate::media::MediaHandle::local(fs::File::open(path).unwrap(), path.to_path_buf()),
        )
    }
    fn wav(samples: &[i16]) -> Vec<u8> {
        let size = std::mem::size_of_val(samples) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&size.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    fn standby_queue_id(engine: &EngineRuntime) -> Option<u64> {
        let track = match engine.audio.as_ref()?.standby() {
            StandbyState::Primed { track, .. } => track,
            _ => return None,
        };
        engine
            .media
            .iter()
            .find_map(|(queue_id, media)| (&media.track == track).then_some(*queue_id))
    }

    #[test]
    fn queue_changes_keep_standby_aligned_with_next() {
        let dir = tempdir().unwrap();
        let paths: Vec<_> = (1..=4)
            .map(|id| {
                let path = dir.path().join(format!("{id}.wav"));
                fs::write(&path, wav(&[id as i16; 32])).unwrap();
                path
            })
            .collect();
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| item(index as u64 + 1, path))
            .collect();
        let mut output = Some(Box::new(TestOutput {
            format: format(),
            state: Arc::new(Mutex::new(State::default())),
            fail_start: false,
        }) as Box<dyn AudioOutput>);
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(move |_format| {
                output
                    .take()
                    .ok_or_else(|| EngineError::AudioBackend("test output already opened".into()))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };

        apply(
            &mut engine,
            EngineCommand::LoadContext {
                items: vec![items[0].clone()],
                start_index: 0,
                media: media(&items[0], &paths[0]),
            },
        )
        .unwrap();
        assert_eq!(standby_queue_id(&engine), None);

        apply(
            &mut engine,
            EngineCommand::Enqueue {
                item: items[1].clone(),
                position: QueueInsertPosition::ContextEnd,
                media: media(&items[1], &paths[1]),
            },
        )
        .unwrap();
        assert_eq!(standby_queue_id(&engine), Some(2));

        apply(
            &mut engine,
            EngineCommand::Enqueue {
                item: items[2].clone(),
                position: QueueInsertPosition::PlayNext,
                media: media(&items[2], &paths[2]),
            },
        )
        .unwrap();
        assert_eq!(standby_queue_id(&engine), Some(3));

        apply(
            &mut engine,
            EngineCommand::PlayNext {
                item: items[3].clone(),
                media: media(&items[3], &paths[3]),
            },
        )
        .unwrap();
        apply(
            &mut engine,
            EngineCommand::Reorder {
                queue_id: 4,
                target_index: 0,
            },
        )
        .unwrap();
        assert_eq!(standby_queue_id(&engine), Some(4));

        apply(&mut engine, EngineCommand::Remove { queue_id: 4 }).unwrap();
        assert_eq!(standby_queue_id(&engine), Some(3));

        apply(&mut engine, EngineCommand::ClearPriority).unwrap();
        assert_eq!(standby_queue_id(&engine), Some(2));

        apply(&mut engine, EngineCommand::SetMode(PlaybackMode::RepeatOne)).unwrap();
        assert_eq!(standby_queue_id(&engine), Some(1));

        apply(
            &mut engine,
            EngineCommand::SetMode(PlaybackMode::Sequential),
        )
        .unwrap();
        apply(&mut engine, EngineCommand::Remove { queue_id: 2 }).unwrap();
        assert_eq!(standby_queue_id(&engine), None);
    }

    #[test]
    fn playing_is_reported_only_after_output_start_succeeds() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("one.wav");
        fs::write(&path, wav(&[1; 32])).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state: Arc::clone(&state),
                fail_start: false,
            }),
        )
        .unwrap();
        let current = item(1, &path);
        let loading = handle
            .request(EngineCommand::LoadContext {
                items: vec![current.clone()],
                start_index: 0,
                media: media(&current, &path),
            })
            .unwrap();
        assert!(matches!(loading.state, PlaybackState::Loading { .. }));
        let playing = handle.request(EngineCommand::Ready).unwrap();
        assert!(matches!(playing.state, PlaybackState::Playing { .. }));
        assert_eq!(state.lock().unwrap().events.first(), Some(&"start"));
        handle.shutdown().unwrap();
    }

    #[test]
    fn failed_output_start_never_reports_playing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("failure.wav");
        fs::write(&path, wav(&[1; 32])).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state,
                fail_start: true,
            }),
        )
        .unwrap();
        let current = item(1, &path);
        handle
            .request(EngineCommand::LoadContext {
                items: vec![current.clone()],
                start_index: 0,
                media: media(&current, &path),
            })
            .unwrap();

        assert!(matches!(
            handle.request(EngineCommand::Ready),
            Err(EngineError::AudioBackend(_))
        ));
        assert!(matches!(
            handle.snapshot().unwrap().state,
            PlaybackState::Loading { .. }
        ));
        handle.shutdown().unwrap();
    }

    #[test]
    fn controls_commit_state_after_output_operations() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("controls.wav");
        fs::write(&path, wav(&vec![1; 20_000])).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state: Arc::clone(&state),
                fail_start: false,
            }),
        )
        .unwrap();
        let current = item(1, &path);
        handle
            .request(EngineCommand::LoadContext {
                items: vec![current.clone()],
                start_index: 0,
                media: media(&current, &path),
            })
            .unwrap();
        handle.request(EngineCommand::Ready).unwrap();
        let paused = handle.request(EngineCommand::Pause).unwrap();
        assert!(matches!(paused.state, PlaybackState::Paused { .. }));
        let sought = handle.request(EngineCommand::Seek(3_000)).unwrap();
        assert!(matches!(
            sought.state,
            PlaybackState::Paused {
                position_ms: 3_000,
                ..
            }
        ));
        let resumed = handle.request(EngineCommand::Resume).unwrap();
        assert!(matches!(resumed.state, PlaybackState::Playing { .. }));
        handle.request(EngineCommand::SetVolume(0.25)).unwrap();
        let stopped = handle.request(EngineCommand::Stop).unwrap();
        assert!(matches!(stopped.state, PlaybackState::Stopped { .. }));
        assert_eq!(
            &state.lock().unwrap().events[..6],
            &["start", "pause", "stop", "start", "volume", "stop"]
        );
        handle.shutdown().unwrap();
    }

    #[test]
    fn eof_automatically_starts_next_real_wav_and_publishes_progress() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("one.wav");
        let second = dir.path().join("two.wav");
        fs::write(&first, wav(&[1; 16])).unwrap();
        fs::write(&second, wav(&[2; 16])).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state,
                fail_start: false,
            }),
        )
        .unwrap();
        let events = handle.subscribe_events(32).unwrap();
        let current = item(1, &first);
        let next = item(2, &second);
        handle
            .request(EngineCommand::LoadContext {
                items: vec![current.clone()],
                start_index: 0,
                media: media(&current, &first),
            })
            .unwrap();
        handle
            .request(EngineCommand::Enqueue {
                item: next.clone(),
                position: QueueInsertPosition::ContextEnd,
                media: media(&next, &second),
            })
            .unwrap();
        handle.request(EngineCommand::Ready).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut saw_second = false;
        while std::time::Instant::now() < deadline {
            if let Ok(event) = events.recv_timeout(Duration::from_millis(50)) {
                if event.kind == EngineEventKind::StateChanged
                    && matches!(event.snapshot.state, PlaybackState::Playing { ref item, .. } if item.queue_id == 2)
                {
                    assert_eq!(event.snapshot.queue.current.as_ref().unwrap().queue_id, 2);
                    assert_eq!(event.snapshot.revision, 3);
                    saw_second = true;
                    break;
                }
            }
        }
        assert!(saw_second);
        handle.shutdown().unwrap();
    }

    #[test]
    fn restored_eof_requests_resolution_without_advancing_queue() {
        let directory = tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = directory.path().join(format!("eof-restore-{id}.wav"));
                fs::write(&path, wav(&[id as i16; 16])).unwrap();
                path
            })
            .collect();
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| item(index as u64 + 1, path))
            .collect();
        let mut queue = PlaybackQueue::new(42);
        queue.replace_context(items.clone(), 0);
        queue.set_mode(PlaybackMode::RepeatAll);
        let original = queue.context_snapshot();
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state: Arc::new(Mutex::new(State::default())),
                fail_start: false,
            }),
        )
        .unwrap();
        let events = handle.subscribe_events(32).unwrap();
        handle
            .request(EngineCommand::RestoreQueue {
                snapshot: original.clone(),
                position_ms: 0,
                resume: false,
            })
            .unwrap();
        handle
            .request(EngineCommand::AttachResolvedMedia {
                media: vec![(1, media(&items[0], &paths[0]))],
            })
            .unwrap();
        handle.request(EngineCommand::Resume).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let requested = loop {
            assert!(std::time::Instant::now() < deadline);
            let event = events.recv_timeout(Duration::from_millis(50)).unwrap();
            if event.kind == EngineEventKind::AutomaticTransitionRequested {
                break event.snapshot;
            }
        };

        assert_eq!(requested.queue, original);
        assert!(matches!(
            requested.state,
            PlaybackState::Paused { ref item, .. } if item.queue_id == 1
        ));
        handle.shutdown().unwrap();
    }

    #[test]
    fn concurrent_queue_commands_are_serialized_without_lost_updates() {
        let directory = Arc::new(tempdir().unwrap());
        let handle = Arc::new(
            EngineHandle::spawn_with_output(
                64,
                1,
                Box::new(WavDecoderFactory),
                Box::new(TestOutput {
                    format: format(),
                    state: Arc::new(Mutex::new(State::default())),
                    fail_start: false,
                }),
            )
            .unwrap(),
        );
        let workers: Vec<_> = (1..=24)
            .map(|id| {
                let handle = Arc::clone(&handle);
                let directory = Arc::clone(&directory);
                thread::spawn(move || {
                    let path = directory.path().join(format!("{id}.wav"));
                    fs::write(&path, wav(&[id as i16; 8])).unwrap();
                    let queued = item(id, &path);
                    handle
                        .request(EngineCommand::Enqueue {
                            item: queued.clone(),
                            position: QueueInsertPosition::ContextEnd,
                            media: media(&queued, &path),
                        })
                        .unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }

        let snapshot = handle.snapshot().unwrap();
        assert_eq!(snapshot.queue.context.len(), 24);
        assert_eq!(snapshot.revision, 24);
        assert_eq!(
            snapshot
                .queue
                .context
                .iter()
                .map(|item| item.queue_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            24
        );
        Arc::try_unwrap(handle).ok().unwrap().shutdown().unwrap();
    }

    #[test]
    fn removing_current_and_clearing_queue_drop_stale_playing_state() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("current.wav");
        let second = dir.path().join("replacement.wav");
        fs::write(&first, wav(&vec![1; 20_000])).unwrap();
        fs::write(&second, wav(&vec![2; 20_000])).unwrap();
        let handle = EngineHandle::spawn_with_output(
            8,
            1,
            Box::new(WavDecoderFactory),
            Box::new(TestOutput {
                format: format(),
                state: Arc::new(Mutex::new(State::default())),
                fail_start: false,
            }),
        )
        .unwrap();
        let current = item(1, &first);
        let replacement = item(2, &second);
        handle
            .request(EngineCommand::LoadContext {
                items: vec![current.clone()],
                start_index: 0,
                media: media(&current, &first),
            })
            .unwrap();
        handle
            .request(EngineCommand::Enqueue {
                item: replacement.clone(),
                position: QueueInsertPosition::ContextEnd,
                media: media(&replacement, &second),
            })
            .unwrap();
        handle.request(EngineCommand::Ready).unwrap();

        let removed = handle
            .request(EngineCommand::Remove { queue_id: 1 })
            .unwrap();
        assert!(matches!(
            removed.state,
            PlaybackState::Stopped { ref item } if item.queue_id == 2
        ));
        assert_eq!(removed.queue.current.as_ref().unwrap().queue_id, 2);

        let cleared = handle.request(EngineCommand::ClearAll).unwrap();
        assert!(matches!(cleared.state, PlaybackState::Idle));
        assert!(cleared.queue.current.is_none());
        assert!(cleared.queue.context.is_empty());
        handle.shutdown().unwrap();
    }

    #[test]
    fn restored_media_attachment_preserves_queue_and_resumes_at_position() {
        let dir = tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = dir.path().join(format!("restored-{id}.wav"));
                fs::write(&path, wav(&vec![id as i16; 20_000])).unwrap();
                path
            })
            .collect();
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| item(index as u64 + 1, path))
            .collect();
        let mut queue = PlaybackQueue::new(42);
        queue.replace_context(items.clone(), 0);
        queue.advance(false);
        queue.play_next(items[2].clone());
        queue.set_mode(PlaybackMode::Shuffle);
        let restored_queue = queue.context_snapshot();
        let mut output = Some(Box::new(TestOutput {
            format: format(),
            state: Arc::new(Mutex::new(State::default())),
            fail_start: false,
        }) as Box<dyn AudioOutput>);
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(move |_format| {
                output
                    .take()
                    .ok_or_else(|| EngineError::AudioBackend("test output already opened".into()))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };

        apply(
            &mut engine,
            EngineCommand::RestoreQueue {
                snapshot: restored_queue.clone(),
                position_ms: 750,
                resume: false,
            },
        )
        .unwrap();
        let before = engine.machine.snapshot();
        apply(
            &mut engine,
            EngineCommand::AttachResolvedMedia {
                media: vec![
                    (2, media(&items[1], &paths[1])),
                    (3, media(&items[2], &paths[2])),
                ],
            },
        )
        .unwrap();
        let attached = engine.machine.snapshot();
        assert_eq!(attached.queue, restored_queue);
        assert_eq!(attached.revision, before.revision);
        assert!(matches!(
            attached.state,
            PlaybackState::Paused {
                ref item,
                position_ms: 750
            } if item.queue_id == 2
        ));

        apply(&mut engine, EngineCommand::Resume).unwrap();
        let resumed = engine.machine.snapshot();
        assert!(matches!(
            resumed.state,
            PlaybackState::Playing {
                ref item,
                position_ms: 750
            } if item.queue_id == 2
        ));
        assert_eq!(resumed.queue, restored_queue);
        assert_eq!(standby_queue_id(&engine), Some(3));
    }

    #[test]
    fn restore_clears_stale_handles_and_failed_attachment_is_atomic() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.wav");
        let new_path = dir.path().join("new.wav");
        fs::write(&old_path, wav(&[1; 32])).unwrap();
        fs::write(&new_path, wav(&[2; 32])).unwrap();
        let old_item = item(1, &old_path);
        let new_item = item(9, &new_path);
        let mut output = Some(Box::new(TestOutput {
            format: format(),
            state: Arc::new(Mutex::new(State::default())),
            fail_start: false,
        }) as Box<dyn AudioOutput>);
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(move |_format| {
                output
                    .take()
                    .ok_or_else(|| EngineError::AudioBackend("test output already opened".into()))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };
        apply(
            &mut engine,
            EngineCommand::LoadContext {
                items: vec![old_item.clone()],
                start_index: 0,
                media: media(&old_item, &old_path),
            },
        )
        .unwrap();
        assert!(engine.media.contains_key(&1));
        let mut restored = PlaybackQueue::new(9);
        restored.replace_context(vec![new_item.clone()], 0);
        apply(
            &mut engine,
            EngineCommand::RestoreQueue {
                snapshot: restored.context_snapshot(),
                position_ms: 0,
                resume: false,
            },
        )
        .unwrap();
        assert!(engine.media.is_empty());

        let mismatched = TrustedResolvedMedia::new(
            old_item.track.clone(),
            crate::media::MediaHandle::local(fs::File::open(&new_path).unwrap(), new_path.clone()),
        );
        assert!(apply(
            &mut engine,
            EngineCommand::AttachResolvedMedia {
                media: vec![(9, media(&new_item, &new_path)), (9, mismatched),],
            },
        )
        .is_err());
        assert!(engine.media.is_empty());
        assert!(matches!(
            engine.machine.state(),
            PlaybackState::Paused { .. }
        ));
    }

    #[test]
    fn restored_resume_without_current_media_stays_paused() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.wav");
        let current = item(4, &path);
        let mut queue = PlaybackQueue::new(1);
        queue.replace_context(vec![current], 0);
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(|_| {
                Err(EngineError::AudioBackend("output must not open".into()))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };
        apply(
            &mut engine,
            EngineCommand::RestoreQueue {
                snapshot: queue.context_snapshot(),
                position_ms: 321,
                resume: false,
            },
        )
        .unwrap();

        assert!(apply(&mut engine, EngineCommand::Resume).is_err());
        assert!(matches!(
            engine.machine.state(),
            PlaybackState::Paused {
                position_ms: 321,
                ..
            }
        ));
    }

    #[test]
    fn restored_three_track_transitions_preserve_order_history_and_repeat_all() {
        let directory = tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = directory.path().join(format!("transition-{id}.wav"));
                fs::write(&path, wav(&vec![id as i16; 20_000])).unwrap();
                path
            })
            .collect();
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| item(index as u64 + 1, path))
            .collect();
        let mut queue = PlaybackQueue::new(42);
        queue.replace_context(items.clone(), 0);
        queue.set_mode(PlaybackMode::RepeatAll);
        let original_order: Vec<_> = queue.context().iter().map(|item| item.queue_id).collect();
        let mut output = Some(Box::new(TestOutput {
            format: format(),
            state: Arc::new(Mutex::new(State::default())),
            fail_start: false,
        }) as Box<dyn AudioOutput>);
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(move |_| {
                output
                    .take()
                    .ok_or_else(|| EngineError::AudioBackend("test output already opened".into()))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };
        apply(
            &mut engine,
            EngineCommand::RestoreQueue {
                snapshot: queue.context_snapshot(),
                position_ms: 0,
                resume: false,
            },
        )
        .unwrap();
        apply(
            &mut engine,
            EngineCommand::AttachResolvedMedia {
                media: items
                    .iter()
                    .zip(&paths)
                    .map(|(item, path)| (item.queue_id, media(item, path)))
                    .collect(),
            },
        )
        .unwrap();
        apply(&mut engine, EngineCommand::Resume).unwrap();
        for expected_queue_id in [2, 3, 1] {
            apply(
                &mut engine,
                EngineCommand::Next {
                    automatic: false,
                    expected_queue_id,
                },
            )
            .unwrap();
        }
        apply(
            &mut engine,
            EngineCommand::Previous {
                expected_queue_id: 3,
            },
        )
        .unwrap();

        let snapshot = engine.machine.snapshot();
        assert_eq!(snapshot.mode, PlaybackMode::RepeatAll);
        assert_eq!(snapshot.queue.current.as_ref().unwrap().queue_id, 3);
        assert_eq!(
            snapshot
                .queue
                .context
                .iter()
                .map(|item| item.queue_id)
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            snapshot
                .queue
                .traversal_history
                .iter()
                .map(|item| item.queue_id)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(snapshot.queue.priority[0].queue_id, 1);
    }

    #[test]
    fn restored_next_without_target_media_preserves_queue_and_position() {
        let directory = tempdir().unwrap();
        let paths: Vec<_> = (1..=3)
            .map(|id| {
                let path = directory.path().join(format!("missing-target-{id}.wav"));
                fs::write(&path, wav(&vec![id as i16; 20_000])).unwrap();
                path
            })
            .collect();
        let items: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| item(index as u64 + 1, path))
            .collect();
        let mut queue = PlaybackQueue::new(42);
        queue.replace_context(items.clone(), 0);
        queue.set_mode(PlaybackMode::RepeatAll);
        let original = queue.context_snapshot();
        let mut engine = EngineRuntime {
            machine: PlaybackMachine::new(1),
            audio: None,
            decoder_factory: Some(Box::new(WavDecoderFactory)),
            output_factory: Some(Box::new(|_| {
                Ok(Box::new(TestOutput {
                    format: format(),
                    state: Arc::new(Mutex::new(State::default())),
                    fail_start: false,
                }))
            })),
            subscribers: Vec::new(),
            media: HashMap::new(),
            pending_restore: false,
        };
        apply(
            &mut engine,
            EngineCommand::RestoreQueue {
                snapshot: original.clone(),
                position_ms: 654,
                resume: false,
            },
        )
        .unwrap();
        apply(
            &mut engine,
            EngineCommand::AttachResolvedMedia {
                media: vec![(1, media(&items[0], &paths[0]))],
            },
        )
        .unwrap();
        apply(&mut engine, EngineCommand::Resume).unwrap();
        apply(&mut engine, EngineCommand::Pause).unwrap();
        let before = engine.machine.snapshot();

        assert!(apply(
            &mut engine,
            EngineCommand::Next {
                automatic: false,
                expected_queue_id: 2,
            }
        )
        .is_err());

        let after = engine.machine.snapshot();
        assert_eq!(after.queue, original);
        assert_eq!(after.revision, before.revision);
        assert!(matches!(
            after.state,
            PlaybackState::Paused {
                ref item,
                position_ms: 654
            } if item.queue_id == 1
        ));
    }

    #[test]
    fn rejects_zero_capacity() {
        assert!(EngineHandle::spawn(0, 1).is_err());
    }
}
