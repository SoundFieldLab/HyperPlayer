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
}
export interface DspPresetDto { id: string; name: string; description: string; partial: boolean; unsupportedStages: string[]; }
export interface DspApplyResultDto { revision: string; status: "applied" | "pending"; partial: boolean; unsupportedStages: string[]; engine: BackendEngineSnapshotDto; configuration: DspConfigurationDto; }
export interface DspHse2ExportDto { code: string; scope: "current21StageProjection"; unsupportedStages: string[]; }

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
  neteaseCloud(cursor?: string | null): Promise<NeteaseCloudPageDto>;
  neteaseImage(url: string): Promise<NeteaseImageDto>;
  neteaseStartQrLogin(): Promise<NeteaseLoginStartDto>;
  neteasePollQrLogin(loginId: string): Promise<NeteaseLoginStateDto>;
  neteaseLogout(): Promise<BackendNeteaseStatusDto>;
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
