export type ContentDomain = "netease" | "local";
export type ThemeMode = "light" | "dark" | "system";
export type MaterialVariant = "clean" | "atmosphere";
export type AudioSource = "netease" | "local";
export type Entitlement = "free" | "vip" | "trial" | "unavailable";
export type CacheState = "none" | "prefetching" | "ready" | "entitlement-locked" | "failed";

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
  /** DSP 配置持久化（D35 Q16：哑 KV，schema 归 TS） */
  dsp: PersistedDspConfigDto | null;
}

/** 持久化 DSP 配置（version + revision + 配置 DTO） */
export interface PersistedDspConfigDto {
  version: number;
  revision: string;
  configuration: Record<string, unknown>;
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
  dsp: {
    version: number;
    revision: string;
    configuration: Record<string, unknown>;
  } | null;
}

export interface BackendAppInfoDto {
  appName: string;
  appVersion: string;
  platform: string;
  initialized: boolean;
}

export interface BackendBootstrapDto {
  app: BackendAppInfoDto;
  settings: BackendSettingsDto;
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

export type WindowKind = "main" | "miniPlayer" | "desktopLyrics";

// ---- 网易云服务层 DTO（D34：UI 保留，服务层在 app/services/netease） ----
import type {
  NeteaseAccountDto,
  NeteaseAlbumDetailDto,
  NeteaseAlbumDto,
  NeteaseArtistDetailDto,
  NeteaseArtistSummaryDto,
  NeteaseBannerDto,
  NeteaseChartDto,
  NeteaseCloudDto,
  NeteaseCommentDto,
  NeteaseCommentPageDto,
  NeteaseDjCategoriesDto,
  NeteaseDjProgramDto,
  NeteaseDjProgramToplistDto,
  NeteaseDjRadioDto,
  NeteaseFavoritesDto,
  NeteaseFollowedEventsPageDto,
  NeteaseHomeDto,
  NeteaseImageDto,
  NeteaseLoginStartDto,
  NeteaseLoginStateDto,
  NeteaseMutationDto,
  NeteaseMvDetailDto,
  NeteaseMvDto,
  NeteaseMvPlaybackDto,
  NeteaseMvsPageDto,
  NeteaseNewSongsDto,
  NeteaseNoticesPageDto,
  NeteasePlaylistDetailDto,
  NeteasePlaylistDto,
  NeteaseRelatedPlaylistsDto,
  NeteaseSearchPageDto,
  NeteaseSearchSuggestionsDto,
  NeteaseSimilarArtistsDto,
  NeteaseSongDto,
  NeteaseStatusDto,
  NeteaseDjRadiosPageDto,
  NeteaseDjProgramsPageDto,
  NeteaseDjRecommendDto,
} from "../services/netease/dto";
export type {
  NeteaseAccountDto,
  NeteaseAlbumDetailDto,
  NeteaseAlbumDto,
  NeteaseArtistDetailDto,
  NeteaseArtistSummaryDto,
  NeteaseBannerDto,
  NeteaseChartDto,
  NeteaseCloudDto,
  NeteaseCommentDto,
  NeteaseCommentPageDto,
  NeteaseDjCategoriesDto,
  NeteaseDjProgramDto,
  NeteaseDjProgramToplistDto,
  NeteaseDjRadioDto,
  NeteaseFavoritesDto,
  NeteaseFollowedEventsPageDto,
  NeteaseHomeDto,
  NeteaseImageDto,
  NeteaseLoginStartDto,
  NeteaseLoginStateDto,
  NeteaseMutationDto,
  NeteaseMvDetailDto,
  NeteaseMvDto,
  NeteaseMvPlaybackDto,
  NeteaseMvsPageDto,
  NeteaseNewSongsDto,
  NeteaseNoticesPageDto,
  NeteasePlaylistDetailDto,
  NeteasePlaylistDto,
  NeteaseRelatedPlaylistsDto,
  NeteaseSearchPageDto,
  NeteaseSearchSuggestionsDto,
  NeteaseSimilarArtistsDto,
  NeteaseSongDto,
  NeteaseStatusDto,
  NeteaseDjRadiosPageDto,
  NeteaseDjProgramsPageDto,
  NeteaseDjRecommendDto,
};
/** 兼容旧桥接命名（删除轮前的 BackendNeteaseStatusDto 等价物） */
export type BackendNeteaseStatusDto = NeteaseStatusDto;
export type NeteaseSearchKind = "track" | "album" | "artist" | "playlist";
export type NeteaseListenPeriod = "week" | "month" | "year";
export type NeteaseCommentResource = "song" | "mv" | "playlist" | "album" | "radio" | "video" | "event" | "digitalAlbum";

/** 播放上下文（D34：WebView 播放链的服务层契约，UI 保留形状） */
export interface PlaybackContextDto {
  kind: "manual" | "search" | "album" | "playlist" | "artist";
  id: string | null;
}

export type QueueInsertPosition = "contextEnd" | "playNext";

/** SMTC 上行元数据（D35 Q13）：Rust 纯桥，只写 SystemMediaTransportControls。 */
export interface SmtcMetadataDto {
  title: string;
  artist: string;
  album: string | null;
  thumbnailDataUrl: string | null;
}

export type SmtcPlaybackState = "playing" | "paused" | "stopped";

export interface SmtcPositionDto {
  positionMs: number;
  durationMs: number | null;
}

/** 媒体键下行（D35 Q13）：Rust 壳 emit，前端播放服务执行。 */
export type MediaButton =
  | "play"
  | "pause"
  | "stop"
  | "next"
  | "previous"
  | "play-pause";

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

export interface IntegrationCapabilityDto {
  available: boolean;
  reason: string | null;
}

export interface WindowsIntegrationStatusDto {
  platform: string;
  smtc: IntegrationCapabilityDto;
  mediaKeys: IntegrationCapabilityDto;
  fileAssociations: IntegrationCapabilityDto;
}

export interface BridgeErrorDto {
  code: string;
  message: string;
}

export interface BackendCloseRequestedDto {
  isPlaying: boolean;
  hasBackgroundTasks: boolean;
}

export type CloseDecision = "cancel" | "minimizeToTray" | "exit";

export interface BridgeBootstrap {
  app: BackendAppInfoDto;
  settings: AppSettingsDto;
  tasks: BackgroundTaskDto[];
  playback: PlaybackSnapshotDto;
}

export interface BridgeEventHandlers {
  scanProgress?(progress: BackendScanProgressDto): void;
  settingsChanged?(settings: AppSettingsDto): void;
  closeRequested?(request: BackendCloseRequestedDto): void;
  playbackChanged?(playback: PlaybackSnapshotDto): void;
  queueChanged?(playback: PlaybackSnapshotDto): void;
  playbackProgress?(progress: { revision: string; positionMs: number; durationMs: number | null }): void;
  neteaseStatusChanged?(status: NeteaseStatusDto): void;
  dspConfigurationRejected?(rejection: { revision: string; code: string; reason: string; stage: string | null }): void;
  dspProcessingFault?(fault: DspProcessingFaultDto): void;
  mediaKeyPressed?(button: MediaButton): void;
}

/** 播放状态快照（D34：WebView 播放链，revision 为离散 UI 状态版本） */
export interface PlaybackSnapshotDto {
  revision: string;
  status: "idle" | "loading" | "playing" | "paused" | "buffering" | "stopped" | "failed";
  current: TrackDto | null;
  currentQueueItemId: string | null;
  positionMs: number;
  durationMs: number | null;
  volume: number;
  repeat: "off" | "all" | "one" | "sequence" | "shuffle";
  shuffled: boolean;
  queue: QueueItemDto[];
  nextUp: QueueItemDto[];
  dspExecution: {
    revision: bigint;
    safeBypassActive: boolean;
    fault: DspProcessingFaultDto | null;
  };
}

/** 队列项（D34：WebView 播放链队列） */
export interface QueueItemDto {
  queueItemId: string;
  track: TrackDto;
}

/** DSP 处理故障（D34：HSE worklet 故障，Rust 安全旁路概念移植 TS） */
export interface DspProcessingFaultDto {
  revision: bigint;
  processorName: string;
  stage: string | null;
  code: string;
  reason: string;
}

/** DSP 配置快照（revision 字符串；各效果 section 的 enabled + 参数） */
export interface DspConfigurationDto {
  revision: string;
  midSide: DspSectionParams;
  loudnessNormalization?: DspSectionParams;
  surround3d?: DspSectionParams;
  preEq?: DspSectionParams;
  ieq?: DspSectionParams;
  dynamicEq?: DspSectionParams;
  compressor?: DspSectionParams;
  deesser?: DspSectionParams;
  bassEnhancer?: DspSectionParams;
  delay?: DspSectionParams;
  chorus?: DspSectionParams;
  flanger?: DspSectionParams;
  phaser?: DspSectionParams;
  tremolo?: DspSectionParams;
  modulation?: DspSectionParams;
  limiter?: DspSectionParams;
  spatial?: DspSectionParams;
  reverb?: DspSectionParams;
  loudnessComp?: DspSectionParams;
  nightMode?: DspSectionParams;
  [section: string]: unknown;
}

/** DSP section 参数（HSE 各效果设置形状，UI 按 section 访问字段） */
export type DspSectionParams = Record<string, unknown> & {
  enabled?: boolean;
};

/** DSP 预设 */
export interface DspPresetDto {
  id: string;
  name: string;
  description: string | null;
  configuration: DspConfigurationDto;
}

/** DSP 应用结果 */
export interface DspApplyResultDto {
  status: "applied" | "rejected" | "partial";
  revision: string;
  configuration: DspConfigurationDto;
  engine: { dspExecution: { revision: bigint } };
  partial: boolean;
  unsupportedStages: string[];
}

/** 歌词负载（WaveForge 逐字时间轴形状） */
export interface LyricsPayloadDto {
  document: {
    lines: Array<{
      startMs: number;
      endMs: number;
      text: string;
      translation?: string;
      roman?: string;
      words: Array<{ text: string; startMs: number; endMs: number }>;
    }>;
  };
}

/** 缓存状态（D30：OPFS 介质，容量/条目/活动任务/权益锁定） */
export interface BackendCacheStatusDto {
  status: "none" | "prefetching" | "ready" | "entitlement-locked" | "failed";
  bytesUsed: number;
  entryCount: number;
  activeTasks: number;
  lockedEntries: number;
}

/** 缓存统计（D30 容量治理） */
export interface CacheStatsDto {
  bytesUsed: number;
  entryCount: number;
  activeTasks: number;
  lockedEntries: number;
}

/** 遥测传输（D31：HSE stats → HPTM v4 帧） */
export interface TelemetryTransport {
  open(rate: 0 | 2 | 15 | 30, onFrame: (frame: ArrayBuffer | ArrayBufferView) => void): Promise<void> | void;
  setRate(rate: 0 | 2 | 15 | 30): Promise<void> | void;
  acknowledge(epoch: bigint, sequence: bigint, revision: bigint): Promise<boolean> | boolean;
  close(): Promise<void> | void;
}

/** 深圳天气（D35 Q20：天气服务 TS 完整实现） */
export interface ShenzhenWeatherDto {
  temperatureC: number;
  humidityPercent: number;
  weatherCode: number;
  description: string;
  updatedAtMs: number;
  isDay: boolean;
  condition: string;
  apparentTemperatureC: number;
  relativeHumidityPercent: number;
  windSpeedKmh: number;
}

export type Unlisten = () => void;

export interface BridgeContract {
  bootstrap(): Promise<BridgeBootstrap>;
  getSettings(): Promise<AppSettingsDto>;
  updateSettings(patch: Partial<AppSettingsDto>): Promise<AppSettingsDto>;
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
  windowShow(kind: WindowKind): Promise<void>;
  windowHide(kind: WindowKind): Promise<void>;
  windowClose(kind: Exclude<WindowKind, "main">): Promise<void>;
  windowSetAlwaysOnTop(kind: WindowKind, enabled: boolean): Promise<void>;
  desktopLyricsSetClickThrough(enabled: boolean): Promise<void>;
  windowsIntegrationStatus(): Promise<WindowsIntegrationStatusDto>;
  windowsEnableMediaControls(): Promise<void>;
  windowsRegisterFileAssociations(extensions: string[]): Promise<void>;
  updaterStatus(): Promise<UpdaterStatusDto>;
  updaterCheck(): Promise<UpdateCheckDto>;
  updaterUpdate(expectedVersion: string): Promise<boolean>;
  credentialGet(): Promise<string | null>;
  credentialSet(payload: string | null): Promise<void>;
  smtcUpdateMetadata(metadata: SmtcMetadataDto): Promise<void>;
  smtcUpdatePlaybackState(state: SmtcPlaybackState): Promise<void>;
  smtcUpdatePosition(position: SmtcPositionDto): Promise<void>;
  // ---- 网易云服务层（D34：UI 保留、服务层实现，非 Tauri command） ----
  neteaseStatus(): Promise<NeteaseStatusDto>;
  neteaseAccount(): Promise<NeteaseAccountDto>;
  neteaseStartQrLogin(): Promise<NeteaseLoginStartDto>;
  neteasePollQrLogin(loginId: string): Promise<NeteaseLoginStateDto>;
  neteaseLogout(): Promise<void>;
  neteaseHome(): Promise<NeteaseHomeDto>;
  neteaseBanner(): Promise<NeteaseBannerDto[]>;
  neteaseCharts(): Promise<NeteaseChartDto[]>;
  neteaseNewSongs(): Promise<NeteaseNewSongsDto>;
  neteaseExploreNext(limit: number, batch: number, exclude: number[]): Promise<{ songs: NeteaseSongDto[]; batch: number }>;
  neteaseSearch(keywords: string, kind: NeteaseSearchKind): Promise<NeteaseSearchPageDto>;
  neteaseSearchHot(): Promise<Array<{ word: string }>>;
  neteaseSearchSuggest(keywords: string): Promise<NeteaseSearchSuggestionsDto>;
  neteasePlaylistDetail(id: number): Promise<NeteasePlaylistDetailDto>;
  neteaseAlbumDetail(id: number): Promise<NeteaseAlbumDetailDto>;
  neteaseArtistDetail(id: number): Promise<NeteaseArtistDetailDto>;
  neteaseRelatedPlaylists(id: number): Promise<NeteaseRelatedPlaylistsDto>;
  neteaseSimilarArtists(id: number): Promise<NeteaseSimilarArtistsDto>;
  neteasePlaymodeIntelligenceList(songId: number, playlistId: number): Promise<{ tracks: NeteaseSongDto[] }>;
  neteaseComments(resource: NeteaseCommentResource, resourceId: number): Promise<NeteaseCommentPageDto>;
  neteasePrepareMutation(mutation: NeteaseMutationDto): Promise<{ confirmationToken: string; summary: string }>;
  neteaseCommitMutation(token: string, confirmed: boolean): Promise<{ succeeded: boolean }>;
  neteaseFavorites(): Promise<NeteaseFavoritesDto>;
  neteaseCloud(): Promise<NeteaseCloudDto>;
  neteaseAlbumSublist(): Promise<{ albums: NeteaseAlbumDto[] }>;
  neteaseArtistSublist(): Promise<{ artists: NeteaseArtistSummaryDto[] }>;
  neteaseMvSublist(): Promise<{ mvs: NeteaseMvDto[] }>;
  neteaseDjSublist(): Promise<{ radios: NeteaseDjRadioDto[] }>;
  neteaseMvs(cursor: string | null): Promise<NeteaseMvsPageDto>;
  neteaseMvDetail(id: number): Promise<NeteaseMvDetailDto>;
  neteaseMvPlayback(id: number): Promise<NeteaseMvPlaybackDto>;
  neteaseDjRadios(cursor: string | null): Promise<NeteaseDjRadiosPageDto>;
  neteaseDjPrograms(radioId: number, cursor: string | null): Promise<NeteaseDjProgramsPageDto>;
  neteaseDjCategories(): Promise<NeteaseDjCategoriesDto>;
  neteaseDjRecommend(): Promise<NeteaseDjRecommendDto>;
  neteaseDjProgramToplist(): Promise<NeteaseDjProgramToplistDto>;
  neteaseNotices(): Promise<NeteaseNoticesPageDto>;
  neteaseFollowedEvents(): Promise<NeteaseFollowedEventsPageDto>;
  neteaseFollows(userId: number): Promise<{ users: Array<{ userId: number; nickname: string; avatarUrl: string | null }>; nextCursor: null }>;
  neteaseListenTotal(): Promise<{ totalMinutes: number; totalPlays: number; songs: NeteaseSongDto[] }>;
  neteaseListenReport(period: NeteaseListenPeriod): Promise<{ period: NeteaseListenPeriod; endTime: number | null; stats: { totalMinutes: number; totalPlays: number; songs: NeteaseSongDto[] } }>;
  neteaseListenSongRank(period: NeteaseListenPeriod): Promise<{ tracks: NeteaseSongDto[] }>;
  neteaseScrobble(payload: { songId: number; sourceId: number; playedSeconds: number }): Promise<void>;
  neteaseImage(src: string): Promise<NeteaseImageDto>;
  neteaseUpdatePlaylistCover(playlistId: number, imageBase64: string, mimeType?: string): Promise<void>;
  // ---- 播放服务（D34：WebView 播放链，TS 服务层） ----
  getPlayback(): Promise<PlaybackSnapshotDto>;
  play(track?: BackendTrackRefDto, context?: PlaybackContextDto): Promise<PlaybackSnapshotDto>;
  pause(): Promise<PlaybackSnapshotDto>;
  stop(): Promise<PlaybackSnapshotDto>;
  next(): Promise<PlaybackSnapshotDto>;
  previous(): Promise<PlaybackSnapshotDto>;
  seek(positionMs: number): Promise<PlaybackSnapshotDto>;
  setVolume(volume: number): Promise<PlaybackSnapshotDto>;
  setRepeatMode(repeat: PlaybackSnapshotDto["repeat"]): Promise<PlaybackSnapshotDto>;
  enqueue(track: BackendTrackRefDto, position: QueueInsertPosition): Promise<PlaybackSnapshotDto>;
  removeQueueItem(queueItemId: string): Promise<PlaybackSnapshotDto>;
  reorderQueueItem(queueItemId: string, targetIndex: number): Promise<PlaybackSnapshotDto>;
  clearQueue(scope: "playNext" | "all"): Promise<PlaybackSnapshotDto>;
  // ---- DSP 服务（D34：HSE 控制面） ----
  dspGetConfiguration(): Promise<DspConfigurationDto>;
  dspListPresets(): Promise<DspPresetDto[]>;
  dspConfigure(request: DspConfigurationDto): Promise<DspApplyResultDto>;
  dspApplyPreset(presetId: string, revision: string): Promise<DspApplyResultDto>;
  dspImportHse2(code: string, revision: string): Promise<DspApplyResultDto>;
  dspExportHse2(): Promise<{ code: string; unsupportedStages: string[] }>;
  // ---- 歌词（D34：WaveForge 歌词成套） ----
  lyricsGet(request: BackendTrackRefDto): Promise<LyricsPayloadDto>;
  // ---- 缓存治理（D30/D34：OPFS 介质，TS 执行） ----
  cacheStatus(request: BackendTrackRefDto): Promise<BackendCacheStatusDto>;
  cacheTrack(request: BackendTrackRefDto, quality: string): Promise<void>;
  cacheRemove(request: BackendTrackRefDto): Promise<void>;
  cacheClear(): Promise<void>;
  cacheStats(): Promise<CacheStatsDto>;
  // ---- 天气（D35 Q20：TS 完整实现） ----
  shenzhenWeather(): Promise<ShenzhenWeatherDto>;
  // ---- 遥测（D31：主窗口可选 vGPU/Canvas 可视化） ----
  createTelemetryTransport(): TelemetryTransport;
  logWeb(level: "info" | "warn" | "error", message: string): Promise<void>;
  resolveClose(action: CloseDecision, remember: boolean): Promise<void>;
  subscribe(handlers: BridgeEventHandlers): Promise<Unlisten>;
}

export const trackRefOf = (track: Pick<TrackDto, "id" | "source">): BackendTrackRefDto => ({
  id: track.id,
  source: track.source,
});