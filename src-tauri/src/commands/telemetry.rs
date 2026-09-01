use crate::{
    commands::command,
    dto::{
        TelemetryAckDto, TelemetryAckRequestDto, TelemetryActivityRequestDto,
        TelemetryCloseRequestDto, TelemetrySessionDto, TelemetrySubscribeRequestDto,
    },
    error::{AppError, AppResult, CommandResult},
    ports::{AppState, TelemetryFrame, TelemetryPort, TelemetrySubscription},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, ipc::InvokeResponseBody, State, WebviewWindow};
use uuid::Uuid;

const MAX_SESSIONS: usize = 2;
const WIRE_HEADER_BYTES: usize = 48;
const WIRE_TRAILER_BYTES: usize = 7 * size_of::<f32>();
const MIN_FRAME_BYTES: u32 = (WIRE_HEADER_BYTES + WIRE_TRAILER_BYTES) as u32;
const MAX_FRAME_BYTES: u32 = 1024;
const MIN_FRAMES_PER_SECOND: u16 = 1;
const MAX_FRAMES_PER_SECOND: u16 = 30;
const WIRE_MAGIC: [u8; 4] = *b"HPTM";
const WIRE_VERSION: u16 = 2;
const EPOCH_OFFSET: usize = 8;
const SEQUENCE_OFFSET: usize = 16;
const DSP_REVISION_OFFSET: usize = 32;

static NEXT_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);

trait BinarySink: Send + Sync + 'static {
    fn send(&self, payload: Vec<u8>) -> Result<(), ()>;
}

struct ChannelSink(Channel<InvokeResponseBody>);

impl BinarySink for ChannelSink {
    fn send(&self, payload: Vec<u8>) -> Result<(), ()> {
        self.0
            .send(InvokeResponseBody::Raw(payload))
            .map_err(|_| ())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct FrameOrdering {
    epoch: u64,
    sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FrameIdentity {
    ordering: FrameOrdering,
    dsp_revision: u64,
}

struct PendingFrame {
    identity: FrameIdentity,
    payload: Vec<u8>,
}

struct SessionFlow {
    rate_hz: u8,
    last_sent: Option<FrameOrdering>,
    in_flight: Option<FrameIdentity>,
    pending: Option<PendingFrame>,
    next_send_at: Instant,
}

struct TelemetrySession {
    id: String,
    control_epoch: u64,
    max_frame_bytes: usize,
    max_frames_per_second: u16,
    closed: AtomicBool,
    flow: Mutex<SessionFlow>,
    wake: SyncSender<()>,
    subscription: Mutex<Option<Box<dyn TelemetrySubscription>>>,
}

impl TelemetrySession {
    fn offer_frame(&self, frame: TelemetryFrame) {
        if self.closed.load(Ordering::Acquire) || frame.payload.len() > self.max_frame_bytes {
            return;
        }
        let Ok(identity) = parse_identity(&frame.payload) else {
            return;
        };
        let Ok(mut flow) = self.flow.lock() else {
            return;
        };
        if flow.rate_hz == 0 {
            return;
        }
        let newest = flow
            .last_sent
            .into_iter()
            .chain(
                flow.pending
                    .as_ref()
                    .map(|pending| pending.identity.ordering),
            )
            .max();
        if newest.is_some_and(|ordering| identity.ordering <= ordering) {
            return;
        }
        flow.pending = Some(PendingFrame {
            identity,
            payload: frame.payload,
        });
        drop(flow);
        let _ = self.wake.try_send(());
    }

    fn acknowledge(&self, request: &TelemetryAckRequestDto) -> AppResult<TelemetryAckDto> {
        self.validate_open()?;
        let mut flow = self.flow.lock().map_err(|_| AppError::StateUnavailable)?;
        let expected = FrameIdentity {
            ordering: FrameOrdering {
                epoch: request.epoch,
                sequence: request.sequence,
            },
            dsp_revision: request.revision,
        };
        if flow.in_flight != Some(expected) {
            return Ok(TelemetryAckDto { accepted: false });
        }
        flow.in_flight = None;
        let has_pending = flow.rate_hz != 0 && flow.pending.is_some();
        drop(flow);
        if has_pending {
            let _ = self.wake.try_send(());
        }
        Ok(TelemetryAckDto { accepted: true })
    }

    fn set_activity(&self, epoch: u64, rate_hz: u8) -> AppResult<()> {
        self.validate_control_epoch(epoch)?;
        validate_activity_rate(rate_hz)?;
        {
            let subscription = self
                .subscription
                .lock()
                .map_err(|_| AppError::StateUnavailable)?;
            subscription
                .as_ref()
                .ok_or_else(|| AppError::Unavailable("telemetry subscription is closed".into()))?
                .set_activity(rate_hz)?;
        }
        let mut flow = self.flow.lock().map_err(|_| AppError::StateUnavailable)?;
        flow.rate_hz = rate_hz;
        flow.next_send_at = Instant::now();
        let should_wake = rate_hz == 0 || (flow.in_flight.is_none() && flow.pending.is_some());
        if rate_hz == 0 {
            flow.pending = None;
            flow.in_flight = None;
        }
        drop(flow);
        if should_wake {
            let _ = self.wake.try_send(());
        }
        Ok(())
    }

    fn validate_control_epoch(&self, epoch: u64) -> AppResult<()> {
        if epoch != self.control_epoch {
            return Err(AppError::InvalidArgument(
                "telemetry session epoch does not match".into(),
            ));
        }
        self.validate_open()
    }

    fn validate_open(&self) -> AppResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(AppError::Unavailable("telemetry session is closed".into()));
        }
        Ok(())
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut flow) = self.flow.lock() {
            flow.rate_hz = 0;
            flow.pending = None;
            flow.in_flight = None;
        }
        if let Ok(mut subscription) = self.subscription.lock() {
            subscription.take();
        }
        let _ = self.wake.try_send(());
    }
}

#[derive(Default)]
struct SessionsInner {
    by_window: HashMap<String, Arc<TelemetrySession>>,
}

#[derive(Default)]
pub struct TelemetrySessions {
    inner: Mutex<SessionsInner>,
}

impl TelemetrySessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn subscribe(
        &self,
        owner_label: &str,
        request: TelemetrySubscribeRequestDto,
        port: &dyn TelemetryPort,
        sink: Arc<dyn BinarySink>,
    ) -> AppResult<TelemetrySessionDto> {
        validate_subscribe_request(&request)?;
        let mut sessions = self.inner.lock().map_err(|_| AppError::StateUnavailable)?;
        sessions
            .by_window
            .retain(|_, session| !session.closed.load(Ordering::Acquire));
        if !sessions.by_window.contains_key(owner_label) && sessions.by_window.len() >= MAX_SESSIONS
        {
            return Err(AppError::Unavailable(
                "the global telemetry session limit has been reached".into(),
            ));
        }

        let (wake, receiver) = mpsc::sync_channel(1);
        let session = Arc::new(TelemetrySession {
            id: Uuid::new_v4().to_string(),
            control_epoch: NEXT_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed),
            max_frame_bytes: request.max_frame_bytes as usize,
            max_frames_per_second: request.max_frames_per_second,
            closed: AtomicBool::new(false),
            flow: Mutex::new(SessionFlow {
                rate_hz: 30,
                last_sent: None,
                in_flight: None,
                pending: None,
                next_send_at: Instant::now(),
            }),
            wake,
            subscription: Mutex::new(None),
        });
        let weak = Arc::downgrade(&session);
        let subscription = port.subscribe(Arc::new(move |frame| {
            if let Some(session) = weak.upgrade() {
                session.offer_frame(frame);
            }
        }))?;
        subscription.set_activity(30)?;
        *session
            .subscription
            .lock()
            .map_err(|_| AppError::StateUnavailable)? = Some(subscription);
        if let Err(error) = spawn_delivery_worker(Arc::downgrade(&session), receiver, sink) {
            session.close();
            return Err(error);
        }
        let replaced = sessions
            .by_window
            .insert(owner_label.to_owned(), session.clone());
        drop(sessions);
        if let Some(replaced) = replaced {
            replaced.close();
        }

        Ok(TelemetrySessionDto {
            session_id: session.id.clone(),
            epoch: session.control_epoch,
            max_frame_bytes: request.max_frame_bytes,
            max_frames_per_second: request.max_frames_per_second,
        })
    }

    fn owned_session(
        &self,
        owner_label: &str,
        session_id: &str,
    ) -> AppResult<Arc<TelemetrySession>> {
        let sessions = self.inner.lock().map_err(|_| AppError::StateUnavailable)?;
        sessions
            .by_window
            .get(owner_label)
            .filter(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::InvalidArgument(
                    "telemetry session does not belong to the invoking window".into(),
                )
            })
    }

    fn acknowledge(
        &self,
        owner_label: &str,
        request: TelemetryAckRequestDto,
    ) -> AppResult<TelemetryAckDto> {
        self.owned_session(owner_label, &request.session_id)?
            .acknowledge(&request)
    }

    fn set_activity(
        &self,
        owner_label: &str,
        request: TelemetryActivityRequestDto,
    ) -> AppResult<()> {
        self.owned_session(owner_label, &request.session_id)?
            .set_activity(request.epoch, request.rate_hz)
    }

    fn close(&self, owner_label: &str, request: TelemetryCloseRequestDto) -> AppResult<()> {
        let mut sessions = self.inner.lock().map_err(|_| AppError::StateUnavailable)?;
        let Some(session) = sessions.by_window.get(owner_label) else {
            if sessions
                .by_window
                .values()
                .any(|session| session.id == request.session_id)
            {
                return Err(AppError::InvalidArgument(
                    "telemetry session does not belong to the invoking window".into(),
                ));
            }
            return Ok(());
        };
        if session.id != request.session_id {
            if sessions
                .by_window
                .values()
                .any(|session| session.id == request.session_id)
            {
                return Err(AppError::InvalidArgument(
                    "telemetry session does not belong to the invoking window".into(),
                ));
            }
            return Ok(());
        }
        session.validate_control_epoch(request.epoch)?;
        let session = sessions
            .by_window
            .remove(owner_label)
            .expect("session was checked above");
        drop(sessions);
        session.close();
        Ok(())
    }

    pub fn close_window_sessions(&self, owner_label: &str) {
        let session = self
            .inner
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.by_window.remove(owner_label));
        if let Some(session) = session {
            session.close();
        }
    }
}

fn validate_subscribe_request(request: &TelemetrySubscribeRequestDto) -> AppResult<()> {
    if !(MIN_FRAME_BYTES..=MAX_FRAME_BYTES).contains(&request.max_frame_bytes) {
        return Err(AppError::InvalidArgument(format!(
            "maxFrameBytes must be between {MIN_FRAME_BYTES} and {MAX_FRAME_BYTES}"
        )));
    }
    if !(MIN_FRAMES_PER_SECOND..=MAX_FRAMES_PER_SECOND).contains(&request.max_frames_per_second) {
        return Err(AppError::InvalidArgument(format!(
            "maxFramesPerSecond must be between {MIN_FRAMES_PER_SECOND} and {MAX_FRAMES_PER_SECOND}"
        )));
    }
    Ok(())
}

fn validate_activity_rate(rate_hz: u8) -> AppResult<()> {
    if matches!(rate_hz, 0 | 2 | 15 | 30) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(
            "rateHz must be one of 0, 2, 15, or 30".into(),
        ))
    }
}

fn parse_identity(payload: &[u8]) -> AppResult<FrameIdentity> {
    let waveform_bins = payload.get(44).copied().map(usize::from);
    let spectrum_bins = payload.get(45).copied().map(usize::from);
    let declared_size = waveform_bins
        .zip(spectrum_bins)
        .and_then(|(waveform, spectrum)| {
            WIRE_HEADER_BYTES
                .checked_add(waveform.checked_mul(8)?)?
                .checked_add(spectrum.checked_mul(2)?)?
                .checked_add(WIRE_TRAILER_BYTES)
        });
    if payload.len() < WIRE_HEADER_BYTES
        || payload.len() > MAX_FRAME_BYTES as usize
        || declared_size != Some(payload.len())
        || payload.get(..4) != Some(WIRE_MAGIC.as_slice())
        || read_u16(payload, 4) != Some(WIRE_VERSION)
    {
        return Err(AppError::InvalidArgument(
            "telemetry frame is not a valid HPTM v2 frame".into(),
        ));
    }
    Ok(FrameIdentity {
        ordering: FrameOrdering {
            epoch: read_u64(payload, EPOCH_OFFSET).expect("validated telemetry epoch bytes"),
            sequence: read_u64(payload, SEQUENCE_OFFSET)
                .expect("validated telemetry sequence bytes"),
        },
        dsp_revision: read_u64(payload, DSP_REVISION_OFFSET)
            .expect("validated telemetry revision bytes"),
    })
}

fn read_u16(payload: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        payload.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u64(payload: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        payload.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn spawn_delivery_worker(
    session: Weak<TelemetrySession>,
    receiver: mpsc::Receiver<()>,
    sink: Arc<dyn BinarySink>,
) -> AppResult<()> {
    std::thread::Builder::new()
        .name("hyperplayer-telemetry-delivery".into())
        .spawn(move || {
            'delivery: while receiver.recv().is_ok() {
                let Some(session) = session.upgrade() else {
                    break;
                };
                if session.closed.load(Ordering::Acquire) {
                    break;
                }
                loop {
                    let send_at = match session.flow.lock() {
                        Ok(flow)
                            if flow.rate_hz != 0
                                && flow.in_flight.is_none()
                                && flow.pending.is_some() =>
                        {
                            flow.next_send_at
                        }
                        _ => continue 'delivery,
                    };
                    let Some(delay) = send_at.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(delay) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break 'delivery,
                    }
                }
                let outbound = match session.flow.lock() {
                    Ok(mut flow)
                        if flow.rate_hz != 0
                            && flow.in_flight.is_none()
                            && flow.pending.is_some() =>
                    {
                        let frame = flow.pending.take().expect("pending frame was checked");
                        flow.last_sent = Some(frame.identity.ordering);
                        flow.in_flight = Some(frame.identity);
                        let delivery_rate = u16::from(flow.rate_hz)
                            .min(session.max_frames_per_second)
                            .max(1);
                        flow.next_send_at = Instant::now()
                            + Duration::from_secs_f64(1.0 / f64::from(delivery_rate));
                        Some(frame.payload)
                    }
                    _ => None,
                };
                if let Some(payload) = outbound {
                    if sink.send(payload).is_err() {
                        session.close();
                        break;
                    }
                }
            }
        })?;
    Ok(())
}

#[tauri::command]
pub fn telemetry_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TelemetrySubscribeRequestDto,
    channel: Channel<InvokeResponseBody>,
) -> CommandResult<TelemetrySessionDto> {
    command(state.telemetry_sessions.subscribe(
        window.label(),
        request,
        state.services.telemetry.as_ref(),
        Arc::new(ChannelSink(channel)),
    ))
}

#[tauri::command]
pub fn telemetry_ack(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TelemetryAckRequestDto,
) -> CommandResult<TelemetryAckDto> {
    command(
        state
            .telemetry_sessions
            .acknowledge(window.label(), request),
    )
}

#[tauri::command]
pub fn telemetry_set_activity(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TelemetryActivityRequestDto,
) -> CommandResult<()> {
    command(
        state
            .telemetry_sessions
            .set_activity(window.label(), request),
    )
}

#[tauri::command]
pub fn telemetry_close(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TelemetryCloseRequestDto,
) -> CommandResult<()> {
    command(state.telemetry_sessions.close(window.label(), request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperplayer_engine::telemetry::{
        SPECTRUM_BINS, TELEMETRY_FRAME_ENCODED_SIZE, WAVEFORM_BINS,
    };
    use std::sync::{atomic::AtomicUsize, mpsc::Receiver};

    #[derive(Default)]
    struct FakePort {
        sink: Mutex<Option<crate::ports::TelemetrySink>>,
        rates: Arc<Mutex<Vec<u8>>>,
        drops: Arc<AtomicUsize>,
    }

    struct FakeSubscription {
        rates: Arc<Mutex<Vec<u8>>>,
        drops: Arc<AtomicUsize>,
    }

    impl TelemetrySubscription for FakeSubscription {
        fn set_activity(&self, rate_hz: u8) -> AppResult<()> {
            self.rates.lock().unwrap().push(rate_hz);
            Ok(())
        }
    }

    impl Drop for FakeSubscription {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::Relaxed);
        }
    }

    impl TelemetryPort for FakePort {
        fn subscribe(
            &self,
            sink: crate::ports::TelemetrySink,
        ) -> AppResult<Box<dyn TelemetrySubscription>> {
            *self.sink.lock().unwrap() = Some(sink);
            Ok(Box::new(FakeSubscription {
                rates: self.rates.clone(),
                drops: self.drops.clone(),
            }))
        }
    }

    impl FakePort {
        fn publish(&self, epoch: u64, sequence: u64, revision: u64, marker: u8) {
            let mut payload = vec![0; TELEMETRY_FRAME_ENCODED_SIZE];
            payload[..4].copy_from_slice(&WIRE_MAGIC);
            payload[4..6].copy_from_slice(&WIRE_VERSION.to_le_bytes());
            payload[EPOCH_OFFSET..EPOCH_OFFSET + 8].copy_from_slice(&epoch.to_le_bytes());
            payload[SEQUENCE_OFFSET..SEQUENCE_OFFSET + 8].copy_from_slice(&sequence.to_le_bytes());
            payload[DSP_REVISION_OFFSET..DSP_REVISION_OFFSET + 8]
                .copy_from_slice(&revision.to_le_bytes());
            payload[44] = WAVEFORM_BINS as u8;
            payload[45] = SPECTRUM_BINS as u8;
            payload[TELEMETRY_FRAME_ENCODED_SIZE - 1] = marker;
            (self.sink.lock().unwrap().as_ref().unwrap())(TelemetryFrame { payload });
        }
    }

    struct TestSink(SyncSender<Vec<u8>>);
    impl BinarySink for TestSink {
        fn send(&self, payload: Vec<u8>) -> Result<(), ()> {
            self.0.send(payload).map_err(|_| ())
        }
    }

    fn subscribe(
        sessions: &TelemetrySessions,
        port: &FakePort,
        owner: &str,
    ) -> (TelemetrySessionDto, Receiver<Vec<u8>>) {
        let (sender, receiver) = mpsc::sync_channel(8);
        let dto = sessions
            .subscribe(
                owner,
                TelemetrySubscribeRequestDto {
                    max_frame_bytes: 1024,
                    max_frames_per_second: 30,
                },
                port,
                Arc::new(TestSink(sender)),
            )
            .unwrap();
        (dto, receiver)
    }

    #[test]
    fn validates_d31_limits_and_session_caps() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (sender, _) = mpsc::sync_channel(1);
        for request in [
            TelemetrySubscribeRequestDto {
                max_frame_bytes: MIN_FRAME_BYTES - 1,
                max_frames_per_second: 30,
            },
            TelemetrySubscribeRequestDto {
                max_frame_bytes: 1025,
                max_frames_per_second: 30,
            },
            TelemetrySubscribeRequestDto {
                max_frame_bytes: 1024,
                max_frames_per_second: 31,
            },
        ] {
            assert!(sessions
                .subscribe("bad", request, &port, Arc::new(TestSink(sender.clone())))
                .is_err());
        }

        let first = subscribe(&sessions, &port, "main").0;
        let duplicate = mpsc::sync_channel(1).0;
        let replacement = sessions
            .subscribe(
                "main",
                TelemetrySubscribeRequestDto {
                    max_frame_bytes: 1024,
                    max_frames_per_second: 30,
                },
                &port,
                Arc::new(TestSink(duplicate)),
            )
            .unwrap();
        assert_ne!(first.session_id, replacement.session_id);
        assert_eq!(port.drops.load(Ordering::Relaxed), 1);
        let other_port = FakePort::default();
        let _ = subscribe(&sessions, &other_port, "dsp");
        let third_port = FakePort::default();
        let third = mpsc::sync_channel(1).0;
        assert!(sessions
            .subscribe(
                "third",
                TelemetrySubscribeRequestDto {
                    max_frame_bytes: 1024,
                    max_frames_per_second: 30,
                },
                &third_port,
                Arc::new(TestSink(third)),
            )
            .is_err());
    }

    #[test]
    fn forwards_engine_frame_unchanged_and_accepts_same_dsp_revision() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (session, receiver) = subscribe(&sessions, &port, "main");
        port.publish(4, 10, 7, 1);
        let first = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first.len(), TELEMETRY_FRAME_ENCODED_SIZE);
        assert_eq!(
            parse_identity(&first).unwrap().ordering,
            FrameOrdering {
                epoch: 4,
                sequence: 10
            }
        );
        assert_eq!(first[TELEMETRY_FRAME_ENCODED_SIZE - 1], 1);

        port.publish(4, 11, 7, 2);
        port.publish(4, 12, 7, 3);
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(
            sessions
                .acknowledge(
                    "main",
                    TelemetryAckRequestDto {
                        session_id: session.session_id.clone(),
                        epoch: 4,
                        sequence: 10,
                        revision: 7,
                    },
                )
                .unwrap()
                .accepted
        );
        let latest = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            parse_identity(&latest).unwrap().ordering,
            FrameOrdering {
                epoch: 4,
                sequence: 12
            }
        );
        assert_eq!(latest[TELEMETRY_FRAME_ENCODED_SIZE - 1], 3);
    }

    #[test]
    fn orders_by_epoch_and_sequence_not_revision() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (session, receiver) = subscribe(&sessions, &port, "main");
        port.publish(8, 9, 100, 1);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        port.publish(8, 8, 101, 2);
        port.publish(9, 0, 1, 3);
        assert!(
            sessions
                .acknowledge(
                    "main",
                    TelemetryAckRequestDto {
                        session_id: session.session_id,
                        epoch: 8,
                        sequence: 9,
                        revision: 100,
                    },
                )
                .unwrap()
                .accepted
        );
        let next = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            parse_identity(&next).unwrap().ordering,
            FrameOrdering {
                epoch: 9,
                sequence: 0
            }
        );
        assert_eq!(next[TELEMETRY_FRAME_ENCODED_SIZE - 1], 3);
    }

    #[test]
    fn ack_validates_engine_epoch_sequence_and_revision() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (session, receiver) = subscribe(&sessions, &port, "main");
        port.publish(3, 5, 7, 1);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        let ack = |epoch, sequence, revision| TelemetryAckRequestDto {
            session_id: session.session_id.clone(),
            epoch,
            sequence,
            revision,
        };
        assert!(!sessions.acknowledge("main", ack(2, 5, 7)).unwrap().accepted);
        assert!(!sessions.acknowledge("main", ack(3, 4, 7)).unwrap().accepted);
        assert!(!sessions.acknowledge("main", ack(3, 5, 6)).unwrap().accepted);
        assert!(sessions.acknowledge("main", ack(3, 5, 7)).unwrap().accepted);
        assert!(!sessions.acknowledge("main", ack(3, 5, 7)).unwrap().accepted);
    }

    #[test]
    fn activity_propagates_rates_gates_frames_and_close_is_owned_idempotent() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (session, receiver) = subscribe(&sessions, &port, "main");
        assert_eq!(*port.rates.lock().unwrap(), vec![30]);
        assert!(sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: session.session_id.clone(),
                    epoch: session.epoch + 1,
                    rate_hz: 0,
                },
            )
            .is_err());
        let inactive = TelemetryActivityRequestDto {
            session_id: session.session_id.clone(),
            epoch: session.epoch,
            rate_hz: 0,
        };
        assert!(sessions.set_activity("other", inactive.clone()).is_err());
        sessions.set_activity("main", inactive).unwrap();
        assert_eq!(*port.rates.lock().unwrap(), vec![30, 0]);
        port.publish(1, 1, 1, 1);
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: session.session_id.clone(),
                    epoch: session.epoch,
                    rate_hz: 10,
                },
            )
            .is_err());
        sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: session.session_id.clone(),
                    epoch: session.epoch,
                    rate_hz: 15,
                },
            )
            .unwrap();
        port.publish(1, 2, 1, 2);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let close = TelemetryCloseRequestDto {
            session_id: session.session_id,
            epoch: session.epoch,
        };
        assert!(sessions
            .close(
                "main",
                TelemetryCloseRequestDto {
                    session_id: close.session_id.clone(),
                    epoch: close.epoch + 1,
                },
            )
            .is_err());
        assert!(sessions.close("other", close.clone()).is_err());
        sessions.close("main", close.clone()).unwrap();
        sessions.close("main", close).unwrap();
        assert_eq!(port.drops.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn malformed_and_oversized_frames_are_dropped() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (_, receiver) = subscribe(&sessions, &port, "main");
        (port.sink.lock().unwrap().as_ref().unwrap())(TelemetryFrame {
            payload: vec![0; TELEMETRY_FRAME_ENCODED_SIZE],
        });
        (port.sink.lock().unwrap().as_ref().unwrap())(TelemetryFrame {
            payload: vec![0; 1025],
        });
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
    }

    #[test]
    fn activity_throttle_recovers_immediately_when_rate_increases() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (session, receiver) = subscribe(&sessions, &port, "main");
        sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: session.session_id.clone(),
                    epoch: session.epoch,
                    rate_hz: 2,
                },
            )
            .unwrap();
        port.publish(1, 1, 1, 1);
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        sessions
            .acknowledge(
                "main",
                TelemetryAckRequestDto {
                    session_id: session.session_id.clone(),
                    epoch: 1,
                    sequence: 1,
                    revision: 1,
                },
            )
            .unwrap();
        port.publish(1, 2, 1, 2);
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());

        sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: session.session_id,
                    epoch: session.epoch,
                    rate_hz: 30,
                },
            )
            .unwrap();
        let recovered = receiver.recv_timeout(Duration::from_millis(150)).unwrap();
        assert_eq!(parse_identity(&recovered).unwrap().ordering.sequence, 2);
    }

    #[test]
    fn same_window_remount_replaces_subscription_and_rejects_stale_control() {
        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (first, _) = subscribe(&sessions, &port, "main");
        let (second, _) = subscribe(&sessions, &port, "main");
        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.epoch, second.epoch);
        assert_eq!(port.drops.load(Ordering::Relaxed), 1);
        assert!(sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: first.session_id,
                    epoch: first.epoch,
                    rate_hz: 0,
                },
            )
            .is_err());
        sessions
            .set_activity(
                "main",
                TelemetryActivityRequestDto {
                    session_id: second.session_id,
                    epoch: second.epoch,
                    rate_hz: 15,
                },
            )
            .unwrap();
    }

    #[test]
    fn window_cleanup_closes_subscription_and_frees_capacity() {
        let sessions = TelemetrySessions::new();
        let main_port = FakePort::default();
        let dsp_port = FakePort::default();
        let third_port = FakePort::default();
        let _ = subscribe(&sessions, &main_port, "main");
        let _ = subscribe(&sessions, &dsp_port, "dsp");

        sessions.close_window_sessions("main");
        assert_eq!(main_port.drops.load(Ordering::Relaxed), 1);
        let _ = subscribe(&sessions, &third_port, "third");
        sessions.close_window_sessions("missing");
    }

    #[test]
    fn accepts_variable_hptm_frame_size_from_declared_counts() {
        let mut payload = vec![0; WIRE_HEADER_BYTES + 8 + 2 + WIRE_TRAILER_BYTES];
        payload[..4].copy_from_slice(&WIRE_MAGIC);
        payload[4..6].copy_from_slice(&WIRE_VERSION.to_le_bytes());
        payload[EPOCH_OFFSET..EPOCH_OFFSET + 8].copy_from_slice(&9_u64.to_le_bytes());
        payload[SEQUENCE_OFFSET..SEQUENCE_OFFSET + 8].copy_from_slice(&10_u64.to_le_bytes());
        payload[DSP_REVISION_OFFSET..DSP_REVISION_OFFSET + 8]
            .copy_from_slice(&11_u64.to_le_bytes());
        payload[44] = 1;
        payload[45] = 1;
        assert_eq!(parse_identity(&payload).unwrap().dsp_revision, 11);
        payload.push(0);
        assert!(parse_identity(&payload).is_err());
    }

    #[test]
    fn producer_is_not_blocked_by_slow_consumer() {
        struct BlockingSink {
            entered: SyncSender<()>,
            release: Mutex<Receiver<()>>,
        }
        impl BinarySink for BlockingSink {
            fn send(&self, _payload: Vec<u8>) -> Result<(), ()> {
                let _ = self.entered.try_send(());
                self.release.lock().unwrap().recv().map_err(|_| ())
            }
        }

        let sessions = TelemetrySessions::new();
        let port = FakePort::default();
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        sessions
            .subscribe(
                "main",
                TelemetrySubscribeRequestDto {
                    max_frame_bytes: 1024,
                    max_frames_per_second: 30,
                },
                &port,
                Arc::new(BlockingSink {
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                }),
            )
            .unwrap();
        port.publish(1, 1, 1, 1);
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        for sequence in 2..1000 {
            port.publish(1, sequence, 1, 2);
        }
        assert!(started.elapsed() < Duration::from_millis(100));
        release_tx.send(()).unwrap();
    }
}
