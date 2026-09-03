import type { TelemetryTransport } from "../visualization/telemetry/session";

export type ContentDomain = "netease" | "local";
export type ThemeMode = "light" | "dark" | "system";
export type MaterialVariant = "clean" | "atmosphere";
export type AudioSource = "netease" | "local";
export type PlaybackStatus = "playing" | "paused" | "buffering" | "unavailable";
export type CacheState = "none" | "prefetching" | "ready" | "entitlement-locked" | "failed";
export type Entitlement = "free" | "vip" | "trial" | "unavailable";

export interface BackendTrackRefDto {
  id: string;
  source: AudioSource;
}

// UI-facing metadata is display-only. Commands cross the trust boundary with BackendTrackRefDto.
export interface TrackDto {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  source: AudioSource;
  entitlement: Entitlement;
  quality: "标准" | "极高" | "无损" | "Hi-Res";
  cache: CacheState;
  coverSeed: string;
}

export interface QueueItemDto {
  queueItemId: string;
  track: TrackDto;
}

export interface PlaybackSnapshotDto {
  revision: number;
  current: TrackDto | null;
  currentQueueItemId: string | null;
  status: PlaybackStatus;
  positionMs: number;
  volume: number;
  queue: QueueItemDto[];
  nextUp: QueueItemDto[];
  repeat: "sequence" | "all" | "one" | "shuffle";
  dsp: { available: boolean; bypassed: boolean; label: string };
  dspExecution: DspExecutionStatusDto;
}

export interface LibrarySummaryDto {
  tracks: number;
  albums: number;
  artists: number;
  folders: string[];
  lastScannedAt: string | null;
}

export interface BackgroundTaskDto {
  id: string;
  kind: "scan" | "cache" | "sync" | "update";
  title: string;
  detail: string;
  progress: number | null;
  state: "running" | "attention" | "complete";
}

export interface AppSettingsDto {
  theme: ThemeMode;
  material: MaterialVariant;
  dynamicColor: boolean;
  reduceMotion: boolean;
  reduceTransparency: boolean;
  restoreQueue: boolean;
  autoPlayOnLaunch: boolean;
  neteaseEnabled: boolean;
  cacheCapacityBytes: number;
  cacheTrimPercent: number;
  cacheRecentTrackLimit: number;
  albumFillEnabled: boolean;
  albumFillQuality: string;
}

export type BackendPlaybackStatus = "stopped" | "paused" | "playing" | "buffering" | "error";
export type BackendRepeatMode = "sequential" | "repeatAll" | "repeatOne" | "shuffle";
export type PlaybackContextKind = "manual" | "album" | "playlist" | "search" | "personalFm";

export interface PlaybackContextDto {
  kind: PlaybackContextKind;
  id: string | null;
}

export interface BackendTrackDto {
  trackRef: BackendTrackRefDto;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
  qualityLabel: string | null;
  playable: boolean;
}

export interface BackendPlaybackStateDto {
  status: BackendPlaybackStatus;
  currentTrack: BackendTrackDto | null;
  positionMs: number;
  durationMs: number | null;
  volume: number;
  muted: boolean;
  repeatMode: BackendRepeatMode;
}

export interface BackendQueueItemDto {
  queueItemId: string;
  track: BackendTrackDto;
}

export interface BackendQueueSnapshotDto {
  currentItemId: string | null;
  playNext: BackendQueueItemDto[];
  context: BackendQueueItemDto[];
  revision: number;
}

export type QueueInsertPosition = "playNext" | "contextEnd";

export interface BackendSettingsDto {
  theme: ThemeMode;
  dynamicColor: boolean;
  reduceMotion: boolean;
  reduceTransparency: boolean;
  restoreQueue: boolean;
  autoplayOnStart: boolean;
  closeBehavior: "ask" | "minimizeToTray" | "exit";
  neteaseEnabled: boolean;
  cacheCapacityBytes: number;
  cacheTrimPercent: number;
  cacheRecentTrackLimit: number;
  albumFillEnabled: boolean;
  albumFillQuality: string;
}

export interface BackendNeteaseStatusDto {
  enabled: boolean;
  authenticated: boolean;
  userId: string | null;
  displayName: string | null;
}

export interface BackendDspAvailabilityDto {
  available: boolean;
  reason: string;
}

export interface BackendDspExecutionFaultDto {
  revision: string;
  processorIndex: number;
  processorName: string;
  kind: "processingFailed" | "nonFiniteOutput";
  streamFrame: string;
  safeBypassActive: boolean;
  fallbackStatus: "rustSafeBypass";
}

export interface BackendDspExecutionStatusDto {
  revision: string;
  safeBypassActive: boolean;
  fault: BackendDspExecutionFaultDto | null;
}

export interface DspExecutionStatusDto {
  revision: bigint;
  safeBypassActive: boolean;
  fault: DspProcessingFaultDto | null;
}

export interface BackendEngineSnapshotDto {
  revision: number;
  playback: BackendPlaybackStateDto;
  queue: BackendQueueSnapshotDto;
  dspExecution: BackendDspExecutionStatusDto;
}

export interface BackendBootstrapDto {
  app: { appName: string; appVersion: string; platform: string; initialized: boolean };
  engine: BackendEngineSnapshotDto;
  settings: BackendSettingsDto;
  netease: BackendNeteaseStatusDto;
  dsp: BackendDspAvailabilityDto;
}

export interface BackendScanProgressDto {
  taskId: string;
  completed: number;
  total: number | null;
  phase: string;
}

export interface PageRequestDto {
  cursor: string | null;
  limit: number;
}

export interface LibraryOverviewDto {
  trackCount: number;
  albumCount: number;
  artistCount: number;
  scanActive: boolean;
}

export interface LibraryPageDto {
  items: BackendTrackDto[];
  nextCursor: string | null;
  total: number;
}

export interface LibraryLocationDto {
  id: string;
  path: string;
}

export interface LibraryLocationSelectionDto {
  selectionTicket: string | null;
  selected: boolean;
}

export interface LibraryAlbumDto {
  id: string;
  title: string;
  artists: string[];
  trackCount: number;
  artworkHash: string | null;
}

export interface LibraryArtistDto {
  id: string;
  name: string;
  trackCount: number;
  albumCount: number;
  artworkHash: string | null;
}

export interface LibraryFolderDto {
  id: string;
  name: string;
  trackCount: number;
}

export interface LibraryPlaylistDto {
  id: string;
  name: string;
  trackCount: number;
  updatedUnixMs: number;
}

export interface LibraryRecentDto {
  track: BackendTrackDto;
  playedUnixMs: number;
  positionMs: number;
}

export interface EntityPageDto<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface LibraryArtworkDto {
  contentHash: string;
  mimeType: string;
  bytes: number[];
}

export interface LibraryMutationResultDto {
  removedFromLibrary: boolean;
  movedToRecycleBin: boolean;
}

export interface TaskAcceptedDto {
  taskId: string;
  accepted: boolean;
}

export type NeteaseSearchKind = "track" | "album" | "artist" | "playlist";

export interface NeteaseSearchPageDto {
  tracks: BackendTrackDto[];
  albums: NeteaseAlbumDto[];
  artists: NeteaseArtistSummaryDto[];
  playlists: NeteasePlaylistDto[];
  nextCursor: string | null;
}

export interface NeteaseArtistDto { id: number; name: string; }
export interface NeteaseAlbumDto { id: number; name: string; coverUrl: string | null; }
export interface NeteasePlaylistDto {
  id: number;
  name: string;
  coverUrl: string | null;
  trackCount: number;
  playCount: number | null;
  ownerId: number;
  ownerName: string | null;
  description: string | null;
}
export interface NeteaseHomeDto { recommendedTracks: BackendTrackDto[]; recommendedPlaylists: NeteasePlaylistDto[]; anonymous: boolean; unavailableSections: string[]; }
export interface NeteaseAlbumDetailDto { album: NeteaseAlbumDto; description: string | null; publishTimeMs: number | null; artist: NeteaseArtistDto | null; tracks: BackendTrackDto[]; }
export interface NeteasePlaylistDetailDto { playlist: NeteasePlaylistDto; tracks: BackendTrackDto[]; }
export interface NeteaseArtistSummaryDto { id: number; name: string; imageUrl: string | null; aliases: string[]; briefDescription: string | null; }
export interface NeteaseArtistDetailDto { artist: NeteaseArtistSummaryDto; hotTracks: BackendTrackDto[]; introduction: string | null; fansCount: number | null; }
export interface NeteaseFmDto { tracks: BackendTrackDto[]; }
export interface NeteaseUserDto { userId: number; nickname: string; avatarUrl: string | null; }
export interface NeteaseVipDto { active: boolean; expiresAtMs: number | null; level: number | null; verifiedAtMs: number; }
export interface NeteaseAccountDto { user: NeteaseUserDto; vip: NeteaseVipDto; }
export interface NeteaseFavoritesDto { likedTrackIds: number[]; playlists: NeteasePlaylistDto[]; }
export type NeteaseCommentResource = "song" | "mv" | "playlist" | "album" | "radio" | "video" | "event" | "digitalAlbum";
export interface NeteaseCommentDto { id: number; content: string; timeText: string | null; likedCount: number; liked: boolean; user: NeteaseUserDto | null; }
export interface NeteaseCommentPageDto { comments: NeteaseCommentDto[]; totalCount: number; hasMore: boolean; nextCursor: string | null; }
export interface NeteaseUserPageDto { users: NeteaseUserDto[]; nextCursor: string | null; }
export interface NeteaseCloudSongDto { cloudId: number; track: BackendTrackDto; fileName: string | null; fileSize: number | null; }
export interface NeteaseCloudPageDto { songs: NeteaseCloudSongDto[]; totalCount: number; hasMore: boolean; nextCursor: string | null; }

export interface NeteaseNoticeDto {
  id: number;
  occurredAtMs: number | null;
  title: string | null;
  text: string;
  user: NeteaseUserDto | null;
}
export interface NeteaseNoticePageDto {
  items: NeteaseNoticeDto[];
  hasMore: boolean;
  nextCursor: number | null;
}
export interface NeteaseSocialEventDto {
  id: number;
  eventType: string | null;
  occurredAtMs: number | null;
  user: NeteaseUserDto | null;
  text: string | null;
  track: BackendTrackDto | null;
}
export interface NeteaseEventPageDto {
  items: NeteaseSocialEventDto[];
  hasMore: boolean;
  nextCursor: number | null;
}
export type NeteaseListenPeriod = "week" | "month" | "year";
export interface NeteaseListenStatsDto {
  totalMinutes: number;
  totalPlays: number;
  songs: BackendTrackDto[];
}
export interface NeteaseListenReportDto {
  period: string;
  endTime: string | null;
  stats: NeteaseListenStatsDto;
}

export type NeteaseMutationDto =
  | { kind: "setAlbumFavorite"; albumId: number; favorite: boolean }
  | { kind: "createPlaylist"; name: string; private: boolean }
  | { kind: "deletePlaylist"; playlistId: number }
  | { kind: "updatePlaylist"; playlistId: number; name: string | null; description: string; tags: string[] }
  | { kind: "setPlaylistFavorite"; playlistId: number; favorite: boolean }
  | { kind: "addPlaylistTracks"; playlistId: number; trackIds: number[] }
  | { kind: "removePlaylistTracks"; playlistId: number; trackIds: number[] }
  | { kind: "setArtistFavorite"; artistId: number; favorite: boolean }
  | { kind: "setMvFavorite"; mvId: number; favorite: boolean }
  | { kind: "setDjRadioFavorite"; radioId: number; favorite: boolean }
  | { kind: "trashFmTrack"; trackId: number }
  | { kind: "setTrackFavorite"; trackId: number; favorite: boolean }
  | { kind: "addComment"; resource: NeteaseCommentResource; resourceId: number; content: string }
  | { kind: "replyComment"; resource: NeteaseCommentResource; resourceId: number; commentId: number; content: string }
  | { kind: "setCommentFavorite"; resource: NeteaseCommentResource; resourceId: number; commentId: number; favorite: boolean }
  | { kind: "deleteComment"; resource: NeteaseCommentResource; resourceId: number; commentId: number }
  | { kind: "setUserFollowed"; userId: number; followed: boolean }
  | { kind: "deleteCloudSong"; cloudId: number };
export interface NeteaseMutationConfirmationDto {
  confirmationToken: string;
  summary: string;
  expiresAtMs: number;
}
export interface NeteaseMutationResultDto {
  succeeded: boolean;
  createdPlaylist: NeteasePlaylistDto | null;
  comment: NeteaseCommentDto | null;
}

export interface NeteaseMvDto {
  id: number;
  name: string;
  coverUrl: string | null;
  durationMs: number | null;
  artists: NeteaseArtistDto[];
  playCount: number | null;
}
export interface NeteaseMvPageDto { items: NeteaseMvDto[]; nextCursor: string | null; }
export interface NeteaseMvDetailDto { mv: NeteaseMvDto; description: string | null; publishTime: string | null; favoriteCount: number | null; commentCount: number | null; }
export interface NeteaseDjRadioDto { id: number; name: string; coverUrl: string | null; description: string | null; programCount: number | null; subscriberCount: number | null; category: string | null; }
export interface NeteaseDjProgramDto { id: number; name: string; radio: NeteaseDjRadioDto; mainTrack: BackendTrackDto | null; durationMs: number | null; listenerCount: number | null; likedCount: number | null; createdAtMs: number | null; }
export interface NeteaseDjPageDto { radios: NeteaseDjRadioDto[]; programs: NeteaseDjProgramDto[]; nextCursor: string | null; }
export interface NeteaseChartDto { id: number; name: string; coverUrl: string | null; updateFrequency: string | null; description: string | null; previewTracks: BackendTrackDto[]; }
export interface NeteaseTracksDto { tracks: BackendTrackDto[]; }
export interface NeteaseHotWordDto { word: string; score: number; }
export interface NeteaseSearchSuggestionsDto { songs: BackendTrackDto[]; artists: NeteaseArtistSummaryDto[]; albums: NeteaseAlbumDto[]; playlists: NeteasePlaylistDto[]; }
export interface NeteaseBannerDto { id: number; title: string; imageUrl: string; targetUrl: string; targetType: number; }
export interface NeteasePlaylistCategoryDto { name: string; id: string; }
export interface NeteasePlaylistPageDto { playlists: NeteasePlaylistDto[]; nextCursor: string | null; }
export interface NeteaseArtistAlbumsDto { albums: NeteaseAlbumDto[]; nextCursor: string | null; }
export interface NeteaseArtistMvsDto { mvs: NeteaseMvDto[]; nextCursor: string | null; }
export interface NeteaseSublistAlbumsDto { albums: NeteaseAlbumDto[]; nextCursor: string | null; }
export interface NeteaseSublistArtistsDto { artists: NeteaseArtistSummaryDto[]; nextCursor: string | null; }
export interface NeteaseSublistMvsDto { mvs: NeteaseMvDto[]; nextCursor: string | null; }
export interface NeteaseLikedStateDto { songId: number; liked: boolean; }
export interface NeteaseHotCommentsDto { comments: NeteaseCommentDto[]; total: number; }
export interface NeteaseCommentFloorDto { floor: number; comments: NeteaseCommentDto[]; }
export interface NeteaseUserLevelDto { level: number; nextLevelExperience: number | null; }
export interface NeteaseUserSubcountDto { playlists: number; albums: number; artists: number; mvs: number; djRadios: number; }
export interface NeteaseStylePreferenceDto { tagIds: number[]; tagNames: string[]; }
export interface NeteaseLoginStatusDto { loggedIn: boolean; userId: number | null; nickname: string | null; }
export interface NeteaseListenDataTodayDto { listenedMs: number; playCount: number; }
export interface NeteaseJourneyOverviewDto { totalListenMs: number; totalPlayCount: number; todayListenMs: number; }
export interface NeteaseRecentPlayDto { playedAtMs: number; resourceType: string; id: number; name: string; subtitle: string | null; coverUrl: string | null; }
export interface NeteaseRecentPlaysDto { items: NeteaseRecentPlayDto[]; }
export interface NeteaseQualityOptionDto { key: string; label: string; bitrate: number; sizeBytes: number; sampleRate: number | null; }
export interface NeteaseScrobbleDto { reported: boolean; }
export interface NeteaseDjCategoriesDto { categories: NeteasePlaylistCategoryDto[]; }
export interface NeteaseSongWikiDto { data: unknown; }
export interface NeteaseSongRelatedBlogsDto { data: unknown; }
export interface NeteaseAlbumExtraDto { company: string; publishTimeMs: number | null; }
export interface NeteaseEnrichedSongDto { track: BackendTrackDto; qualityLevels: NeteaseQualityOptionDto[]; albumExtra: NeteaseAlbumExtraDto | null; }
export interface NeteaseAlbumCoverDto { id: number; coverUrl: string | null; }
export interface NeteaseAlbumCoversDto { covers: NeteaseAlbumCoverDto[]; }
export interface NeteaseExploreNextDto { songs: BackendTrackDto[]; batch: number; hasMore: boolean; }
export interface NeteaseSimilarArtistsDto { artists: NeteaseArtistSummaryDto[]; nextCursor: string | null; }
export interface NeteaseUpdatePlaylistCoverRequestDto { playlistId: number; imageBase64: string; mimeType: string | null; }
export interface NeteaseMvPlaybackDto { id: number; url: string; resolution: number; sizeBytes: number | null; durationMs: number | null; }

export interface NeteaseImageDto {
  mimeType: string;
  bytes: number[];
}

export interface NeteaseLoginStartDto {
  loginId: string;
  qrImageDataUrl: string;
  expiresAt: string;
}

export type NeteaseLoginPhase = "waiting" | "scanned" | "confirmed" | "expired" | "failed";

export interface NeteaseLoginStateDto {
  phase: NeteaseLoginPhase;
  status: BackendNeteaseStatusDto;
}

export interface CacheStatsDto {
  entryCount: number;
  bytesUsed: number;
  activeTasks: number;
  lockedEntries: number;
}

export interface LyricWordDto {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LyricLineDto {
  startMs: number;
  endMs: number | null;
  text: string;
  translation: string | null;
  romanization: string | null;
  words: LyricWordDto[];
}

export interface LyricsPayloadDto {
  document: {
    source: string;
    title: string | null;
    artists: string[];
    album: string | null;
    language: string | null;
    offsetMs: number;
    lines: LyricLineDto[];
  };
  rawOriginal: string;
  rawTranslation: string;
  rawRomanization: string;
  rawWordSynced: string;
  rawWordSyncedTranslation: string;
  rawTtml: string;
}

export type WindowKind = "main" | "miniPlayer" | "desktopLyrics";

export interface UpdaterStatusDto {
  enabled: boolean;
  reason: string | null;
}

export interface UpdateCheckDto {
  available: boolean;
  version: string | null;
  currentVersion: string;
  notes: string | null;
}

export interface ShenzhenWeatherDto {
  location: string;
  observedAt: string;
  temperatureC: number;
  apparentTemperatureC: number;
  relativeHumidityPercent: number;
  weatherCode: number;
  condition: string;
  windSpeedKmh: number;
  isDay: boolean;
}

export interface BridgeErrorDto {
  code: string;
  message: string;
}

export interface BackendPlaybackProgressDto {
  revision: number;
  positionMs: number;
  durationMs: number | null;
}

export interface BackendDspConfigurationRejectedDto {
  revision: string;
  code: "validationFailed" | "compilationFailed" | "applyFailed";
  reason: string;
  stage: "validate" | "compile" | "apply" | null;
}

export interface DspConfigurationRejectedDto {
  revision: bigint;
  code: "validationFailed" | "compilationFailed" | "applyFailed";
  reason: string;
  stage: "validate" | "compile" | "apply" | null;
}

export interface BackendDspProcessingFaultDto {
  revision: string;
  processorIndex: number;
  processorName: string;
  kind: "processingFailed" | "nonFiniteOutput";
  streamFrame: string;
  safeBypassActive: boolean;
  fallbackStatus: "rustSafeBypass";
}

export interface DspProcessingFaultDto {
  revision: bigint;
  processorIndex: number;
  processorName: string;
  kind: "processingFailed" | "nonFiniteOutput";
  streamFrame: bigint;
  safeBypassActive: boolean;
  fallbackStatus: "rustSafeBypass";
}

export interface BackendCacheStatusDto {
  track: BackendTrackRefDto;
  quality: string | null;
  cachedVersions: number;
  status: "missing" | "queued" | "caching" | "ready" | "lockedEntitlement" | "failed";
  accessClass: "public" | "accountEntitled";
  ownerUserId: string | null;
  lastValidatedAt: string | null;
}

export interface BackendCloseRequestedDto {
  isPlaying: boolean;
  hasBackgroundTasks: boolean;
}

export type CloseDecision = "cancel" | "minimizeToTray" | "exit";

export interface BridgeBootstrap {
  playback: PlaybackSnapshotDto;
  settings: AppSettingsDto;
  tasks: BackgroundTaskDto[];
}

export interface BridgeEventHandlers {
  playbackChanged?(playback: PlaybackSnapshotDto): void;
  playbackProgress?(progress: BackendPlaybackProgressDto): void;
  queueChanged?(playback: PlaybackSnapshotDto): void;
  scanProgress?(progress: BackendScanProgressDto): void;
  settingsChanged?(settings: AppSettingsDto): void;
  cacheStatusChanged?(status: BackendCacheStatusDto): void;
  neteaseStatusChanged?(status: BackendNeteaseStatusDto): void;
  dspConfigurationRejected?(failure: DspConfigurationRejectedDto): void;
  dspProcessingFault?(fault: DspProcessingFaultDto): void;
  closeRequested?(request: BackendCloseRequestedDto): void;
}

export type Unlisten = () => void;

export interface DspEqBandDto { frequency: number; gain: number; q: number; }
export interface DspReverbBandDto { frequency: number; gain: number; }
export interface DspDynamicEqBandDto { enabled: boolean; frequency: number; targetGainDb: number; }
export interface DspConfigurationDto {
  revision: string;
  loudnessNormalization: { enabled: boolean; targetLufs: number; maxGainDb: number; minGainDb: number; useRealtimeMeter: boolean; externalGainDb: number };
  surround3d: { enabled: boolean; distance: number; speed: number; angle: number; direction: number };
  midSide: { enabled: boolean; stereoWidth: number; voiceBalance: number };
  preEq: { enabled: boolean; bandCount: number; qCompensation: boolean; stereoMode: "independent" | "hseShared"; bands: DspEqBandDto[] };
  deesser: { enabled: boolean; centerHz: number; q: number; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; splitBand: boolean; mix: number };
  compressor: { enabled: boolean; thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number; makeupDb: number; outputGain: number };
  nightMode: { enabled: boolean; amount: number };
  delay: { enabled: boolean; delayMs: number; feedback: number; mix: number };
  chorus: { enabled: boolean; rateHz: number; depthMs: number; mix: number };
  flanger: { enabled: boolean; rateHz: number; depthMs: number; feedback: number; mix: number };
  phaser: { enabled: boolean; rateHz: number; depth: number; feedback: number; mix: number; stages: number };
  tremolo: { enabled: boolean; rateHz: number; depth: number; mix: number };
  reverb: { enabled: boolean; mode: "algorithmic" | "fdn" | "convolution"; reverbType: "hall" | "room" | "plate" | "spring" | "stage"; roomSize: number; damping: number; wet: number; dry: number; preDelayMs: number; width: number; fdnLines: number; mix: number; partitionSize: number; shortRegionMs: number };
  bassEnhancer: { enabled: boolean; cutoffHz: number; q: number; harmonicType: "odd" | "even" | "atan" | "soft"; harmonicGain: number; mix: number; levelDb: number; lowBoostDb: number | null };
  loudnessComp: { enabled: boolean; mode: "auto" | "preset" | "custom"; preset: "flat" | "bass" | "vocal" | "warm" | "bright" | "night"; volumePercent: number; maxBoostDb: number; smoothingSeconds: number; bands: DspReverbBandDto[] };
  ieq: { enabled: boolean; strength: number; targetCurve: "flat" | "warm" | "bright" | "vocal"; timeConstantSec: number };
  dynamicEq: { enabled: boolean; strength: number; thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number; blockSize: number; bands: DspDynamicEqBandDto[] };
  modulation: { enabled: boolean; lfoShape: "sine" | "triangle" | "square" | "saw"; lfoRateHz: number; lfoDepth: number; envelopeAttackMs: number; envelopeReleaseMs: number; envelopeAmount: number; routes: { source: "lfo" | "envelope"; target: "masterGain" | "stereoWidth"; depth: number; polarity: number; smoothingMs: number }[] };
  limiter: { enabled: boolean; thresholdDb: number; lookaheadMs: number; attackMs: number; releaseMs: number; truePeak: boolean };
  lufsMetering: { mode: "hseV151" | "ituBs17705" };
  spatial: { mode: "off" | "instant" | "headLocked" | "world" | "stage"; masterGain: number; instantAmount: number; instantSpreadDeg: number; instantRoom: "off" | "studio" | "hall" | "stage" | "church" | "outdoor" | "bathroom" | "corridor"; instantRoomAmount: number; distanceModel: "inverse" | "linear" | "exponential"; refDistance: number; maxDistance: number; convolution: "time" | "partitioned"; hrtfInterp: "nearest" | "spherical"; stagePreset: "stage" | "cinema" | "piano" | "nature"; seat: "front" | "middle" | "back"; stageRoomSize: number; stageReverbAmount: number; worldOcclusion: number; ambienceEnabled: boolean; ambienceAmount: number };
}
export interface DspPresetDto { id: string; name: string; description: string; partial: boolean; unsupportedStages: string[]; }
export interface DspApplyResultDto { revision: string; status: "applied" | "pending"; partial: boolean; unsupportedStages: string[]; engine: BackendEngineSnapshotDto; configuration: DspConfigurationDto; }
export interface DspHse2ExportDto { code: string; scope: "current22StageProjection"; unsupportedStages: string[]; }

export interface BridgeContract {
  bootstrap(): Promise<BridgeBootstrap>;
  getPlayback(): Promise<PlaybackSnapshotDto>;
  play(track?: BackendTrackRefDto, context?: PlaybackContextDto): Promise<PlaybackSnapshotDto>;
  pause(): Promise<PlaybackSnapshotDto>;
  stop(): Promise<PlaybackSnapshotDto>;
  next(): Promise<PlaybackSnapshotDto>;
  previous(): Promise<PlaybackSnapshotDto>;
  setRepeatMode(mode: PlaybackSnapshotDto["repeat"]): Promise<PlaybackSnapshotDto>;
  seek(positionMs: number): Promise<PlaybackSnapshotDto>;
  setVolume(volume: number): Promise<PlaybackSnapshotDto>;
  getSettings(): Promise<AppSettingsDto>;
  dspGetConfiguration(): Promise<DspConfigurationDto>;
  dspConfigure(configuration: DspConfigurationDto): Promise<DspApplyResultDto>;
  dspListPresets(): Promise<DspPresetDto[]>;
  dspApplyPreset(presetId: string, revision: string): Promise<DspApplyResultDto>;
  dspImportHse2(code: string, revision: string): Promise<DspApplyResultDto>;
  dspExportHse2(): Promise<DspHse2ExportDto>;
  updateSettings(patch: Partial<AppSettingsDto>): Promise<AppSettingsDto>;
  enqueue(track: BackendTrackRefDto, position: QueueInsertPosition): Promise<PlaybackSnapshotDto>;
  removeQueueItem(queueItemId: string): Promise<PlaybackSnapshotDto>;
  reorderQueueItem(queueItemId: string, targetIndex: number): Promise<PlaybackSnapshotDto>;
  clearQueue(scope: "playNext" | "all"): Promise<PlaybackSnapshotDto>;
  libraryOverview(): Promise<LibraryOverviewDto>;
  libraryQuery(search?: string, cursor?: string | null): Promise<LibraryPageDto>;
  libraryQueryAlbums(search?: string, cursor?: string | null): Promise<EntityPageDto<LibraryAlbumDto>>;
  libraryQueryArtists(search?: string, cursor?: string | null): Promise<EntityPageDto<LibraryArtistDto>>;
  libraryQueryFolders(search?: string, cursor?: string | null): Promise<EntityPageDto<LibraryFolderDto>>;
  libraryQueryRecent(cursor?: string | null): Promise<EntityPageDto<LibraryRecentDto>>;
  libraryQueryPlaylists(search?: string, cursor?: string | null): Promise<EntityPageDto<LibraryPlaylistDto>>;
  libraryCreatePlaylist(name: string): Promise<LibraryPlaylistDto>;
  libraryRenamePlaylist(id: string, name: string): Promise<LibraryPlaylistDto>;
  libraryDeletePlaylist(id: string): Promise<void>;
  libraryAddPlaylistTrack(playlistId: string, trackId: string): Promise<void>;
  libraryRemovePlaylistTrack(playlistId: string, trackId: string): Promise<void>;
  libraryReorderPlaylistTrack(playlistId: string, trackId: string, targetPosition: number): Promise<void>;
  libraryEntityTracks(kind: "album" | "artist" | "folder" | "playlist", id: string, cursor?: string | null): Promise<LibraryPageDto>;
  libraryArtwork(contentHash: string): Promise<LibraryArtworkDto>;
  libraryRereadTags(trackId: string): Promise<BackendTrackDto>;
  libraryRemoveFromLibrary(trackId: string): Promise<LibraryMutationResultDto>;
  libraryMoveToRecycleBin(trackId: string): Promise<LibraryMutationResultDto>;
  libraryPickLocation(): Promise<LibraryLocationSelectionDto>;
  libraryRegisterLocation(selectionTicket: string): Promise<LibraryLocationDto>;
  libraryStartScan(locationIds: string[]): Promise<TaskAcceptedDto>;
  libraryCancelScan(taskId: string): Promise<void>;
  neteaseStatus(): Promise<BackendNeteaseStatusDto>;
  neteaseSearch(query: string, kind?: NeteaseSearchKind, cursor?: string | null): Promise<NeteaseSearchPageDto>;
  neteaseMvs(cursor?: string | null): Promise<NeteaseMvPageDto>;
  neteaseMvDetail(id: number): Promise<NeteaseMvDetailDto>;
  neteaseDjRadios(cursor?: string | null): Promise<NeteaseDjPageDto>;
  neteaseDjPrograms(radioId: number, cursor?: string | null): Promise<NeteaseDjPageDto>;
  neteaseCharts(): Promise<NeteaseChartDto[]>;
  neteaseNewSongs(areaId?: number): Promise<NeteaseTracksDto>;
  neteaseHome(): Promise<NeteaseHomeDto>;
  neteaseAlbumDetail(id: number): Promise<NeteaseAlbumDetailDto>;
  neteasePlaylistDetail(id: number): Promise<NeteasePlaylistDetailDto>;
  neteaseArtistDetail(id: number): Promise<NeteaseArtistDetailDto>;
  neteasePersonalFm(): Promise<NeteaseFmDto>;
  neteaseAccount(): Promise<NeteaseAccountDto>;
  neteaseFavorites(): Promise<NeteaseFavoritesDto>;
  neteaseComments(resource: NeteaseCommentResource, resourceId: number, cursor?: string | null): Promise<NeteaseCommentPageDto>;
  neteaseFollows(userId: number, cursor?: string | null): Promise<NeteaseUserPageDto>;
  neteaseNotices(cursor?: number | null, limit?: number): Promise<NeteaseNoticePageDto>;
  neteaseFollowedEvents(cursor?: number | null, limit?: number): Promise<NeteaseEventPageDto>;
  neteaseListenTotal(): Promise<NeteaseListenStatsDto>;
  neteaseListenReport(period: NeteaseListenPeriod, endTime?: string | null): Promise<NeteaseListenReportDto>;
  neteaseListenSongRank(period: NeteaseListenPeriod, endTime?: string | null): Promise<NeteaseTracksDto>;
  neteasePrepareMutation(mutation: NeteaseMutationDto): Promise<NeteaseMutationConfirmationDto>;
  neteaseCommitMutation(confirmationToken: string, confirmed: boolean): Promise<NeteaseMutationResultDto>;
  neteaseCloud(cursor?: string | null): Promise<NeteaseCloudPageDto>;
  neteaseImage(url: string): Promise<NeteaseImageDto>;
  neteaseStartQrLogin(): Promise<NeteaseLoginStartDto>;
  neteasePollQrLogin(loginId: string): Promise<NeteaseLoginStateDto>;
  neteaseLogout(): Promise<BackendNeteaseStatusDto>;
  neteaseSearchHot(): Promise<NeteaseHotWordDto[]>;
  neteaseSearchSuggest(query: string): Promise<NeteaseSearchSuggestionsDto>;
  neteaseBanner(): Promise<NeteaseBannerDto[]>;
  neteasePlaylistCategories(): Promise<NeteasePlaylistCategoryDto[]>;
  neteaseHighQualityPlaylists(cat: string, cursor?: string | null): Promise<NeteasePlaylistPageDto>;
  neteaseSimilarPlaylists(id: number): Promise<NeteasePlaylistPageDto>;
  neteaseArtistAlbums(artistId: number, cursor?: string | null): Promise<NeteaseArtistAlbumsDto>;
  neteaseArtistMvs(artistId: number, cursor?: string | null): Promise<NeteaseArtistMvsDto>;
  neteaseArtistSublist(cursor?: string | null): Promise<NeteaseSublistArtistsDto>;
  neteaseAlbumSublist(cursor?: string | null): Promise<NeteaseSublistAlbumsDto>;
  neteaseMvSublist(cursor?: string | null): Promise<NeteaseSublistMvsDto>;
  neteasePersonalizedNewSongs(): Promise<NeteaseTracksDto>;
  neteaseDislikeRecommendSong(id: number): Promise<NeteaseMutationResultDto>;
  neteaseCheckSongsLiked(ids: number[]): Promise<NeteaseLikedStateDto[]>;
  neteaseHotComments(id: number, cursor?: string | null): Promise<NeteaseHotCommentsDto>;
  neteaseCommentFloor(id: number, parentCommentId: number, cursor?: string | null): Promise<NeteaseCommentFloorDto>;
  neteaseMsgComments(userId: number, cursor?: string | null): Promise<NeteaseCommentPageDto>;
  neteaseUserFolloweds(userId: number, cursor?: string | null): Promise<NeteaseUserPageDto>;
  neteaseUserLevel(): Promise<NeteaseUserLevelDto>;
  neteaseUserSubcount(): Promise<NeteaseUserSubcountDto>;
  neteaseStylePreference(): Promise<NeteaseStylePreferenceDto>;
  neteaseLoginStatus(): Promise<NeteaseLoginStatusDto>;
  neteaseListenDataToday(): Promise<NeteaseListenDataTodayDto>;
  neteaseJourneyOverview(): Promise<NeteaseJourneyOverviewDto>;
  neteaseRecentPlays(kind: string, userId: number, limit?: number): Promise<NeteaseRecentPlaysDto>;
  neteaseSimilarSongs(id: number): Promise<NeteaseTracksDto>;
  neteaseSongQualityLevels(id: number): Promise<NeteaseQualityOptionDto[]>;
  neteaseScrobble(id: number, positionMs: number): Promise<NeteaseScrobbleDto>;
  neteaseDjCategories(): Promise<NeteaseDjCategoriesDto>;
  neteaseDjRecommend(limit?: number): Promise<NeteaseDjPageDto>;
  neteaseDjProgramToplist(cursor?: string | null): Promise<NeteaseDjPageDto>;
  neteaseDjSublist(cursor?: string | null): Promise<NeteaseDjPageDto>;
  neteasePersonalizedDjRadios(limit?: number): Promise<NeteaseDjPageDto>;
  neteaseSongWiki(id: number): Promise<NeteaseSongWikiDto>;
  neteaseSongRelatedBlogs(albumId: number): Promise<NeteaseSongRelatedBlogsDto>;
  neteaseSongDetailEnriched(id: number): Promise<NeteaseEnrichedSongDto>;
  neteasePlaymodeIntelligenceList(songId: number, playlistId: number): Promise<NeteaseTracksDto>;
  neteaseRelatedPlaylists(playlistId: number): Promise<NeteasePlaylistPageDto>;
  neteaseAlbumCoversBatch(ids: number[]): Promise<NeteaseAlbumCoversDto>;
  neteaseSimilarArtists(artistId: number): Promise<NeteaseSimilarArtistsDto>;
  neteaseExploreNext(count?: number, batch?: number, exclude?: number[]): Promise<NeteaseExploreNextDto>;
  neteaseUpdatePlaylistCover(playlistId: number, imageBase64: string, mimeType?: string): Promise<NeteaseMutationResultDto>;
  neteaseMvPlayback(mvId: number, resolution?: number): Promise<NeteaseMvPlaybackDto>;
  cacheStats(): Promise<CacheStatsDto>;
  cacheStatus(track: BackendTrackRefDto): Promise<BackendCacheStatusDto>;
  cacheTrack(track: BackendTrackRefDto, quality: string): Promise<TaskAcceptedDto>;
  cacheRemove(track: BackendTrackRefDto): Promise<void>;
  cacheClear(): Promise<TaskAcceptedDto>;
  lyricsGet(track: BackendTrackRefDto): Promise<LyricsPayloadDto>;
  windowShow(kind: WindowKind): Promise<void>;
  windowHide(kind: WindowKind): Promise<void>;
  windowClose(kind: Exclude<WindowKind, "main">): Promise<void>;
  windowSetAlwaysOnTop(kind: WindowKind, enabled: boolean): Promise<void>;
  desktopLyricsSetClickThrough(enabled: boolean): Promise<void>;
  updaterStatus(): Promise<UpdaterStatusDto>;
  updaterCheck(): Promise<UpdateCheckDto>;
  updaterUpdate(expectedVersion: string): Promise<boolean>;
  shenzhenWeather(): Promise<ShenzhenWeatherDto>;
  resolveClose(action: CloseDecision, remember: boolean): Promise<void>;
  createTelemetryTransport(): TelemetryTransport;
  subscribe(handlers: BridgeEventHandlers): Promise<Unlisten>;
}

export const trackRefOf = (track: Pick<TrackDto, "id" | "source">): BackendTrackRefDto => ({
  id: track.id,
  source: track.source,
});
