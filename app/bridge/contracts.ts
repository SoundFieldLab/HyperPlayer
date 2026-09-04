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
}

export interface BridgeEventHandlers {
  scanProgress?(progress: BackendScanProgressDto): void;
  settingsChanged?(settings: AppSettingsDto): void;
  closeRequested?(request: BackendCloseRequestedDto): void;
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
  logWeb(level: "info" | "warn" | "error", message: string): Promise<void>;
  resolveClose(action: CloseDecision, remember: boolean): Promise<void>;
  subscribe(handlers: BridgeEventHandlers): Promise<Unlisten>;
}

export const trackRefOf = (track: Pick<TrackDto, "id" | "source">): BackendTrackRefDto => ({
  id: track.id,
  source: track.source,
});