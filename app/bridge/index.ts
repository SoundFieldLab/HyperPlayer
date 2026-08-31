import { fallbackCover } from "../artwork";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import type {
  AppSettingsDto,
  BackendBootstrapDto,
  BackendCacheStatusDto,
  BackendCloseRequestedDto,
  BackendNeteaseStatusDto,
  BackendPlaybackProgressDto,
  BackendPlaybackStateDto,
  BackendQueueSnapshotDto,
  BackendScanProgressDto,
  BackendSettingsDto,
  BackendTrackDto,
  BackendTrackRefDto,
  BackgroundTaskDto,
  BridgeContract,
  BridgeEventHandlers,
  CacheStatsDto,
  CloseDecision,
  LibraryAlbumDto,
  LibraryArtistDto,
  LibraryArtworkDto,
  LibraryFolderDto,
  LibraryLocationDto,
  LibraryLocationSelectionDto,
  LibraryMutationResultDto,
  LibraryOverviewDto,
  LibraryPageDto,
  LibraryPlaylistDto,
  LibraryRecentDto,
  EntityPageDto,
  LyricsPayloadDto,
  NeteaseAccountDto,
  NeteaseAlbumDetailDto,
  NeteaseArtistDetailDto,
  NeteaseCloudPageDto,
  NeteaseCommentPageDto,
  NeteaseCommentResource,
  NeteaseFavoritesDto,
  NeteaseFmDto,
  NeteaseHomeDto,
  NeteaseImageDto,
  NeteaseLoginStartDto,
  NeteaseLoginStateDto,
  NeteasePlaylistDetailDto,
  NeteaseSearchKind,
  NeteaseSearchPageDto,
  NeteaseUserPageDto,
  PlaybackSnapshotDto,
  QueueInsertPosition,
  QueueItemDto,
  TaskAcceptedDto,
  TrackDto,
  Unlisten,
  UpdateCheckDto,
  UpdaterStatusDto,
  WindowKind,
} from "./contracts";

export const TAURI_COMMANDS = {
  bootstrap: "bootstrap",
  playbackGetState: "playback_get_state",
  playbackPlay: "playback_play",
  playbackPause: "playback_pause",
  playbackStop: "playback_stop",
  playbackNext: "playback_next",
  playbackPrevious: "playback_previous",
  playbackSetRepeatMode: "playback_set_repeat_mode",
  playbackSeek: "playback_seek",
  playbackSetVolume: "playback_set_volume",
  queueEnqueue: "queue_enqueue",
  queueRemove: "queue_remove",
  queueReorder: "queue_reorder",
  queueClearPlayNext: "queue_clear_play_next",
  queueClearAll: "queue_clear_all",
  settingsGet: "settings_get",
  settingsUpdate: "settings_update",
  libraryOverview: "library_overview",
  libraryQueryTracks: "library_query_tracks",
  libraryQueryAlbums: "library_query_albums",
  libraryQueryArtists: "library_query_artists",
  libraryQueryFolders: "library_query_folders",
  libraryQueryRecent: "library_query_recent",
  libraryQueryPlaylists: "library_query_playlists",
  libraryAlbumTracks: "library_album_tracks",
  libraryArtistTracks: "library_artist_tracks",
  libraryFolderTracks: "library_folder_tracks",
  libraryPlaylistTracks: "library_playlist_tracks",
  libraryArtwork: "library_artwork",
  libraryRereadTags: "library_reread_tags",
  libraryRemoveFromLibrary: "library_remove_from_library",
  libraryMoveToRecycleBin: "library_move_to_recycle_bin",
  libraryPickLocation: "library_pick_location",
  libraryRegisterLocation: "library_register_location",
  libraryStartScan: "library_start_scan",
  libraryCancelScan: "library_cancel_scan",
  neteaseStatus: "netease_status",
  neteaseSearch: "netease_search",
  neteaseHome: "netease_home",
  neteaseAlbumDetail: "netease_album_detail",
  neteasePlaylistDetail: "netease_playlist_detail",
  neteaseArtistDetail: "netease_artist_detail",
  neteasePersonalFm: "netease_personal_fm",
  neteaseAccount: "netease_account",
  neteaseFavorites: "netease_favorites",
  neteaseComments: "netease_comments",
  neteaseFollows: "netease_follows",
  neteaseCloud: "netease_cloud",
  neteaseImage: "netease_image",
  neteaseStartQrLogin: "netease_start_qr_login",
  neteasePollQrLogin: "netease_poll_qr_login",
  neteaseLogout: "netease_logout",
  cacheStats: "cache_stats",
  cacheStatus: "cache_status",
  cacheTrack: "cache_track",
  cacheRemove: "cache_remove",
  cacheClear: "cache_clear",
  lyricsGet: "lyrics_get",
  windowShow: "window_show",
  windowHide: "window_hide",
  windowClose: "window_close",
  windowSetAlwaysOnTop: "window_set_always_on_top",
  desktopLyricsSetClickThrough: "desktop_lyrics_set_click_through",
  updaterStatus: "updater_status",
  updaterCheck: "updater_check",
  windowResolveClose: "window_resolve_close",
} as const;

export const TAURI_EVENTS = {
  playbackStateChanged: "hyperplayer://playback/state-changed",
  playbackProgress: "hyperplayer://playback/progress",
  queueChanged: "hyperplayer://queue/changed",
  libraryScanProgress: "hyperplayer://library/scan-progress",
  settingsChanged: "hyperplayer://settings/changed",
  cacheStatusChanged: "hyperplayer://cache/status-changed",
  neteaseStatusChanged: "hyperplayer://netease/status-changed",
  closeRequested: "hyperplayer://window/close-requested",
  lyricsChanged: "hyperplayer://lyrics/changed",
  mediaKeyPressed: "hyperplayer://windows/media-key-pressed",
  updaterStatusChanged: "hyperplayer://updater/status-changed",
  engineSnapshotChanged: "hyperplayer://engine/snapshot-changed",
} as const;

const materialKey = "hyperplayer.material";
const getMaterial = (): AppSettingsDto["material"] => localStorage.getItem(materialKey) === "atmosphere" ? "atmosphere" : "clean";

function quality(value: string | null): TrackDto["quality"] {
  return value === "Hi-Res" || value === "无损" || value === "极高" ? value : "标准";
}

export function adaptTrack(track: BackendTrackDto): TrackDto {
  const fallbackIndex = Math.abs([...track.trackRef.id].reduce((sum, char) => sum + char.charCodeAt(0), 0));
  return {
    id: track.trackRef.id,
    title: track.title,
    artists: track.artists,
    album: track.album ?? "未知专辑",
    durationMs: track.durationMs ?? 0,
    source: track.trackRef.source,
    entitlement: track.playable ? "free" : "unavailable",
    quality: quality(track.qualityLabel),
    cache: "none",
    coverSeed: fallbackCover(String(fallbackIndex)),
  };
}

function adaptQueueItem(item: { queueItemId: string; track: BackendTrackDto }): QueueItemDto {
  return { queueItemId: item.queueItemId, track: adaptTrack(item.track) };
}

function adaptSettings(settings: BackendSettingsDto): AppSettingsDto {
  return {
    theme: settings.theme,
    material: getMaterial(),
    dynamicColor: settings.dynamicColor,
    reduceMotion: settings.reduceMotion,
    reduceTransparency: settings.reduceTransparency,
    restoreQueue: settings.restoreQueue,
    autoPlayOnLaunch: settings.autoplayOnStart,
    neteaseEnabled: settings.neteaseEnabled,
  };
}

function settingsRequest(patch: Partial<AppSettingsDto>): Partial<BackendSettingsDto> {
  const request: Partial<BackendSettingsDto> = {};
  if (patch.theme !== undefined) request.theme = patch.theme;
  if (patch.dynamicColor !== undefined) request.dynamicColor = patch.dynamicColor;
  if (patch.reduceMotion !== undefined) request.reduceMotion = patch.reduceMotion;
  if (patch.reduceTransparency !== undefined) request.reduceTransparency = patch.reduceTransparency;
  if (patch.restoreQueue !== undefined) request.restoreQueue = patch.restoreQueue;
  if (patch.autoPlayOnLaunch !== undefined) request.autoplayOnStart = patch.autoPlayOnLaunch;
  if (patch.neteaseEnabled !== undefined) request.neteaseEnabled = patch.neteaseEnabled;
  return request;
}

export function adaptPlayback(state: BackendPlaybackStateDto, queue: BackendQueueSnapshotDto): PlaybackSnapshotDto {
  return {
    current: state.currentTrack ? adaptTrack(state.currentTrack) : null,
    currentQueueItemId: queue.currentItemId,
    status: state.status === "error" || state.status === "stopped" ? "unavailable" : state.status,
    positionMs: state.positionMs,
    volume: state.volume,
    queue: queue.context.map(adaptQueueItem),
    nextUp: queue.playNext.map(adaptQueueItem),
    repeat: { sequential: "sequence", repeatAll: "all", repeatOne: "one", shuffle: "shuffle" }[state.repeatMode] as PlaybackSnapshotDto["repeat"],
    dsp: { available: false, bypassed: true, label: "规格待接入" },
  };
}

function localTasks(_bootstrap: BackendBootstrapDto): BackgroundTaskDto[] {
  return [];
}

export function bridgeError(error: unknown): { code: string; message: string; unavailable: boolean } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === "string") {
      const code = typeof candidate.code === "string" ? candidate.code : "unknown";
      return { code, message: candidate.message, unavailable: code === "unavailable" };
    }
  }
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  return { code: "unknown", message, unavailable: false };
}

function tauriBridge(): BridgeContract {
  let playbackState: BackendPlaybackStateDto | null = null;
  let queueState: BackendQueueSnapshotDto = { currentItemId: null, playNext: [], context: [], revision: 0 };
  let playbackEventVersion = 0;

  const snapshot = () => {
    if (!playbackState) throw new Error("Playback state is not initialized");
    return adaptPlayback(playbackState, queueState);
  };
  const updatePlayback = (state: BackendPlaybackStateDto) => { playbackState = state; return snapshot(); };
  const updateQueue = (queue: BackendQueueSnapshotDto) => { queueState = queue; return snapshot(); };
  const invokeQueue = async (command: string, args?: Record<string, unknown>) => updateQueue(await invoke<BackendQueueSnapshotDto>(command, args));

  return {
    async bootstrap() {
      const observedPlaybackVersion = playbackEventVersion;
      const observedQueueRevision = queueState.revision;
      const value = await invoke<BackendBootstrapDto>(TAURI_COMMANDS.bootstrap);
      if (playbackEventVersion === observedPlaybackVersion) playbackState = value.playback;
      if (queueState.revision === observedQueueRevision && value.queue.revision >= queueState.revision) queueState = value.queue;
      return { playback: snapshot(), settings: adaptSettings(value.settings), tasks: localTasks(value) };
    },
    async getPlayback() { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackGetState)); },
    async play(track, context = { kind: "manual", id: null }) {
      const request = track ? { track, context } : null;
      return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackPlay, { request }));
    },
    async pause() { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackPause)); },
    async stop() { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackStop)); },
    async next() { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackNext)); },
    async previous() { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackPrevious)); },
    async setRepeatMode(mode) {
      const backendMode = { sequence: "sequential", all: "repeatAll", one: "repeatOne", shuffle: "shuffle" }[mode];
      return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackSetRepeatMode, { mode: backendMode }));
    },
    async seek(positionMs) { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackSeek, { request: { positionMs } })); },
    async setVolume(volume) { return updatePlayback(await invoke<BackendPlaybackStateDto>(TAURI_COMMANDS.playbackSetVolume, { request: { volume } })); },
    async getSettings() { return adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsGet)); },
    async updateSettings(patch) {
      if (patch.material !== undefined) localStorage.setItem(materialKey, patch.material);
      const request = settingsRequest(patch);
      if (Object.keys(request).length === 0) return { ...(await this.getSettings()), material: patch.material ?? getMaterial() };
      return { ...adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsUpdate, { request })), material: patch.material ?? getMaterial() };
    },
    async enqueue(track, position: QueueInsertPosition) { return invokeQueue(TAURI_COMMANDS.queueEnqueue, { request: { track, position } }); },
    async removeQueueItem(queueItemId) { return invokeQueue(TAURI_COMMANDS.queueRemove, { request: { queueItemId } }); },
    async reorderQueueItem(queueItemId, targetIndex) { return invokeQueue(TAURI_COMMANDS.queueReorder, { request: { queueItemId, targetIndex } }); },
    async clearQueue(scope) { return invokeQueue(scope === "all" ? TAURI_COMMANDS.queueClearAll : TAURI_COMMANDS.queueClearPlayNext); },
    async libraryOverview() { return invoke<LibraryOverviewDto>(TAURI_COMMANDS.libraryOverview); },
    async libraryQuery(search, cursor = null) {
      return invoke<LibraryPageDto>(TAURI_COMMANDS.libraryQueryTracks, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } });
    },
    async libraryQueryAlbums(search, cursor = null) { return invoke<EntityPageDto<LibraryAlbumDto>>(TAURI_COMMANDS.libraryQueryAlbums, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryArtists(search, cursor = null) { return invoke<EntityPageDto<LibraryArtistDto>>(TAURI_COMMANDS.libraryQueryArtists, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryFolders(search, cursor = null) { return invoke<EntityPageDto<LibraryFolderDto>>(TAURI_COMMANDS.libraryQueryFolders, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryRecent(cursor = null) { return invoke<EntityPageDto<LibraryRecentDto>>(TAURI_COMMANDS.libraryQueryRecent, { page: { cursor, limit: 100 } }); },
    async libraryQueryPlaylists(search, cursor = null) { return invoke<EntityPageDto<LibraryPlaylistDto>>(TAURI_COMMANDS.libraryQueryPlaylists, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryEntityTracks(kind, id, cursor = null) {
      const command = { album: TAURI_COMMANDS.libraryAlbumTracks, artist: TAURI_COMMANDS.libraryArtistTracks, folder: TAURI_COMMANDS.libraryFolderTracks, playlist: TAURI_COMMANDS.libraryPlaylistTracks }[kind];
      return invoke<LibraryPageDto>(command, { request: { id, page: { cursor, limit: 100 } } });
    },
    async libraryArtwork(contentHash) { return invoke<LibraryArtworkDto>(TAURI_COMMANDS.libraryArtwork, { request: { contentHash } }); },
    async libraryRereadTags(trackId) { return invoke<BackendTrackDto>(TAURI_COMMANDS.libraryRereadTags, { request: { trackId } }); },
    async libraryRemoveFromLibrary(trackId) { return invoke<LibraryMutationResultDto>(TAURI_COMMANDS.libraryRemoveFromLibrary, { request: { trackId } }); },
    async libraryMoveToRecycleBin(trackId) { return invoke<LibraryMutationResultDto>(TAURI_COMMANDS.libraryMoveToRecycleBin, { request: { trackId } }); },
    async libraryPickLocation() { return invoke<LibraryLocationSelectionDto>(TAURI_COMMANDS.libraryPickLocation); },
    async libraryRegisterLocation(selectionTicket) { return invoke<LibraryLocationDto>(TAURI_COMMANDS.libraryRegisterLocation, { request: { selectionTicket } }); },
    async libraryStartScan(locationIds) { return invoke<TaskAcceptedDto>(TAURI_COMMANDS.libraryStartScan, { request: { locationIds } }); },
    async libraryCancelScan(taskId) { await invoke(TAURI_COMMANDS.libraryCancelScan, { taskId }); },
    async neteaseStatus() { return invoke<BackendNeteaseStatusDto>(TAURI_COMMANDS.neteaseStatus); },
    async neteaseSearch(query, kind: NeteaseSearchKind = "track", cursor = null) {
      return invoke<NeteaseSearchPageDto>(TAURI_COMMANDS.neteaseSearch, { request: { query, kind, page: { cursor, limit: 50 } } });
    },
    async neteaseHome() { return invoke<NeteaseHomeDto>(TAURI_COMMANDS.neteaseHome); },
    async neteaseAlbumDetail(id) { return invoke<NeteaseAlbumDetailDto>(TAURI_COMMANDS.neteaseAlbumDetail, { request: { id } }); },
    async neteasePlaylistDetail(id) { return invoke<NeteasePlaylistDetailDto>(TAURI_COMMANDS.neteasePlaylistDetail, { request: { id } }); },
    async neteaseArtistDetail(id) { return invoke<NeteaseArtistDetailDto>(TAURI_COMMANDS.neteaseArtistDetail, { request: { id } }); },
    async neteasePersonalFm() { return invoke<NeteaseFmDto>(TAURI_COMMANDS.neteasePersonalFm); },
    async neteaseAccount() { return invoke<NeteaseAccountDto>(TAURI_COMMANDS.neteaseAccount); },
    async neteaseFavorites() { return invoke<NeteaseFavoritesDto>(TAURI_COMMANDS.neteaseFavorites); },
    async neteaseComments(resource: NeteaseCommentResource, resourceId, cursor = null) { return invoke<NeteaseCommentPageDto>(TAURI_COMMANDS.neteaseComments, { request: { resource, resourceId, page: { cursor, limit: 50 } } }); },
    async neteaseFollows(userId, cursor = null) { return invoke<NeteaseUserPageDto>(TAURI_COMMANDS.neteaseFollows, { request: { userId, page: { cursor, limit: 50 } } }); },
    async neteaseCloud(cursor = null) { return invoke<NeteaseCloudPageDto>(TAURI_COMMANDS.neteaseCloud, { page: { cursor, limit: 50 } }); },
    async neteaseImage(url) { return invoke<NeteaseImageDto>(TAURI_COMMANDS.neteaseImage, { request: { url } }); },
    async neteaseStartQrLogin() { return invoke<NeteaseLoginStartDto>(TAURI_COMMANDS.neteaseStartQrLogin); },
    async neteasePollQrLogin(loginId) { return invoke<NeteaseLoginStateDto>(TAURI_COMMANDS.neteasePollQrLogin, { request: { loginId } }); },
    async neteaseLogout() { return invoke<BackendNeteaseStatusDto>(TAURI_COMMANDS.neteaseLogout); },
    async cacheStats() { return invoke<CacheStatsDto>(TAURI_COMMANDS.cacheStats); },
    async cacheStatus(track) { return invoke<BackendCacheStatusDto>(TAURI_COMMANDS.cacheStatus, { track }); },
    async cacheTrack(track, quality) { return invoke<TaskAcceptedDto>(TAURI_COMMANDS.cacheTrack, { request: { track, quality } }); },
    async cacheRemove(track) { await invoke(TAURI_COMMANDS.cacheRemove, { track }); },
    async cacheClear() { return invoke<TaskAcceptedDto>(TAURI_COMMANDS.cacheClear); },
    async lyricsGet(track) { return invoke<LyricsPayloadDto>(TAURI_COMMANDS.lyricsGet, { request: { track } }); },
    async windowShow(kind: WindowKind) { await invoke(TAURI_COMMANDS.windowShow, { request: { kind } }); },
    async windowHide(kind: WindowKind) { await invoke(TAURI_COMMANDS.windowHide, { request: { kind } }); },
    async windowClose(kind) { await invoke(TAURI_COMMANDS.windowClose, { request: { kind } }); },
    async windowSetAlwaysOnTop(kind: WindowKind, enabled) { await invoke(TAURI_COMMANDS.windowSetAlwaysOnTop, { request: { kind, enabled } }); },
    async desktopLyricsSetClickThrough(enabled) { await invoke(TAURI_COMMANDS.desktopLyricsSetClickThrough, { request: { kind: "desktopLyrics", enabled } }); },
    async updaterStatus() { return invoke<UpdaterStatusDto>(TAURI_COMMANDS.updaterStatus); },
    async updaterCheck() { return invoke<UpdateCheckDto>(TAURI_COMMANDS.updaterCheck); },
    async resolveClose(action: CloseDecision, remember) { await invoke(TAURI_COMMANDS.windowResolveClose, { request: { action, remember } }); },
    async subscribe(handlers: BridgeEventHandlers): Promise<Unlisten> {
      const listeners: Unlisten[] = [];
      const add = async <T>(event: string, handler: (event: Event<T>) => void) => { listeners.push(await listen<T>(event, handler)); };
      try {
        await add<BackendPlaybackStateDto>(TAURI_EVENTS.playbackStateChanged, ({ payload }) => { playbackEventVersion += 1; handlers.playbackChanged?.(updatePlayback(payload)); });
        await add<BackendPlaybackProgressDto>(TAURI_EVENTS.playbackProgress, ({ payload }) => handlers.playbackProgress?.(payload));
        await add<BackendQueueSnapshotDto>(TAURI_EVENTS.queueChanged, ({ payload }) => { queueState = payload; if (playbackState) handlers.queueChanged?.(snapshot()); });
        await add<BackendScanProgressDto>(TAURI_EVENTS.libraryScanProgress, ({ payload }) => handlers.scanProgress?.(payload));
        await add<BackendSettingsDto>(TAURI_EVENTS.settingsChanged, ({ payload }) => handlers.settingsChanged?.(adaptSettings(payload)));
        await add<BackendCacheStatusDto>(TAURI_EVENTS.cacheStatusChanged, ({ payload }) => handlers.cacheStatusChanged?.(payload));
        await add<BackendNeteaseStatusDto>(TAURI_EVENTS.neteaseStatusChanged, ({ payload }) => handlers.neteaseStatusChanged?.(payload));
        await add<BackendCloseRequestedDto>(TAURI_EVENTS.closeRequested, ({ payload }) => handlers.closeRequested?.(payload));
      } catch (error) {
        listeners.forEach((unlisten) => unlisten());
        throw error;
      }
      return () => listeners.splice(0).forEach((unlisten) => unlisten());
    },
  };
}

export const bridge: BridgeContract = tauriBridge();
