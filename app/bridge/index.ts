import { fallbackCover } from "../artwork";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { createTauriTelemetryTransport } from "../visualization/telemetry/tauri-transport";
import type {
  AppSettingsDto,
  BackendBootstrapDto,
  BackendCacheStatusDto,
  BackendCloseRequestedDto,
  BackendDspConfigurationRejectedDto,
  BackendDspProcessingFaultDto,
  BackendEngineSnapshotDto,
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
  DspConfigurationRejectedDto,
  DspConfigurationDto,
  DspApplyResultDto,
  DspHse2ExportDto,
  DspPresetDto,
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
  NeteaseChartDto,
  NeteaseDjPageDto,
  NeteaseLoginStartDto,
  NeteaseLoginStateDto,
  NeteaseMvDetailDto,
  NeteaseMvPageDto,
  NeteasePlaylistDetailDto,
  NeteaseSearchKind,
  NeteaseSearchPageDto,
  NeteaseTracksDto,
  NeteaseUserPageDto,
  PlaybackSnapshotDto,
  QueueInsertPosition,
  QueueItemDto,
  ShenzhenWeatherDto,
  TaskAcceptedDto,
  TrackDto,
  Unlisten,
  UpdateCheckDto,
  UpdaterStatusDto,
  WindowKind,
} from "./contracts";
import type { TelemetryTransport } from "../visualization/telemetry/session";

type TauriBridgeContract = BridgeContract & {
  createTelemetryTransport(): TelemetryTransport;
};

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
  dspGetConfiguration: "dsp_get_configuration",
  dspConfigure: "dsp_configure",
  dspListPresets: "dsp_list_presets",
  dspApplyPreset: "dsp_apply_preset",
  dspImportHse2: "dsp_import_hse2",
  dspExportHse2: "dsp_export_hse2",
  libraryOverview: "library_overview",
  libraryQueryTracks: "library_query_tracks",
  libraryQueryAlbums: "library_query_albums",
  libraryQueryArtists: "library_query_artists",
  libraryQueryFolders: "library_query_folders",
  libraryQueryRecent: "library_query_recent",
  libraryQueryPlaylists: "library_query_playlists",
  libraryCreatePlaylist: "library_create_playlist",
  libraryRenamePlaylist: "library_rename_playlist",
  libraryDeletePlaylist: "library_delete_playlist",
  libraryAddPlaylistTrack: "library_add_playlist_track",
  libraryRemovePlaylistTrack: "library_remove_playlist_track",
  libraryReorderPlaylistTrack: "library_reorder_playlist_track",
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
  neteaseMvs: "netease_mvs",
  neteaseMvDetail: "netease_mv_detail",
  neteaseDjRadios: "netease_dj_radios",
  neteaseDjPrograms: "netease_dj_programs",
  neteaseCharts: "netease_charts",
  neteaseNewSongs: "netease_new_songs",
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
  updaterUpdate: "updater_update",
  shenzhenWeather: "shenzhen_weather",
  telemetrySubscribe: "telemetry_subscribe",
  telemetryAck: "telemetry_ack",
  telemetrySetActivity: "telemetry_set_activity",
  telemetryClose: "telemetry_close",
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
  dspConfigurationRejected: "hyperplayer://dsp/configuration-rejected",
  dspProcessingFault: "hyperplayer://dsp/processing-fault",
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
    cacheCapacityBytes: settings.cacheCapacityBytes,
    cacheTrimPercent: settings.cacheTrimPercent,
    cacheRecentTrackLimit: settings.cacheRecentTrackLimit,
    albumFillEnabled: settings.albumFillEnabled,
    albumFillQuality: settings.albumFillQuality,
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
  if (patch.cacheCapacityBytes !== undefined) request.cacheCapacityBytes = patch.cacheCapacityBytes;
  if (patch.cacheTrimPercent !== undefined) request.cacheTrimPercent = patch.cacheTrimPercent;
  if (patch.cacheRecentTrackLimit !== undefined) request.cacheRecentTrackLimit = patch.cacheRecentTrackLimit;
  if (patch.albumFillEnabled !== undefined) request.albumFillEnabled = patch.albumFillEnabled;
  if (patch.albumFillQuality !== undefined) request.albumFillQuality = patch.albumFillQuality;
  return request;
}

export function adaptDspConfigurationRejected(
  payload: BackendDspConfigurationRejectedDto,
): DspConfigurationRejectedDto {
  return { ...payload, revision: BigInt(payload.revision) };
}

export function adaptPlayback(snapshot: BackendEngineSnapshotDto): PlaybackSnapshotDto {
  const { playback: state, queue } = snapshot;
  return {
    revision: snapshot.revision,
    current: state.currentTrack ? adaptTrack(state.currentTrack) : null,
    currentQueueItemId: queue.currentItemId,
    status: state.status === "error" || state.status === "stopped" ? "unavailable" : state.status,
    positionMs: state.positionMs,
    volume: state.volume,
    queue: queue.context.map(adaptQueueItem),
    nextUp: queue.playNext.map(adaptQueueItem),
    repeat: { sequential: "sequence", repeatAll: "all", repeatOne: "one", shuffle: "shuffle" }[state.repeatMode] as PlaybackSnapshotDto["repeat"],
    dsp: {
      available: true,
      bypassed: BigInt(snapshot.dspExecution.revision) === 0n || snapshot.dspExecution.safeBypassActive,
      label: "Rust DSP runtime 与参数桥已接通；当前支持 21 阶段实时处理（spatial 待合规资产）",
    },
    dspExecution: {
      revision: BigInt(snapshot.dspExecution.revision),
      safeBypassActive: snapshot.dspExecution.safeBypassActive,
      fault: snapshot.dspExecution.fault
        ? {
            ...snapshot.dspExecution.fault,
            revision: BigInt(snapshot.dspExecution.fault.revision),
            streamFrame: BigInt(snapshot.dspExecution.fault.streamFrame),
          }
        : null,
    },
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

export function createEngineSnapshotGate() {
  let engineState: BackendEngineSnapshotDto | null = null;

  const dspSeverity = (status: BackendEngineSnapshotDto["dspExecution"]) =>
    status.fault ? 2 : status.safeBypassActive ? 1 : 0;

  const mergeDspExecution = (
    current: BackendEngineSnapshotDto["dspExecution"],
    candidate: BackendEngineSnapshotDto["dspExecution"],
  ) => {
    if (BigInt(candidate.revision) > BigInt(current.revision)) return candidate;
    if (BigInt(candidate.revision) < BigInt(current.revision)) return current;
    return dspSeverity(candidate) > dspSeverity(current) ? candidate : current;
  };

  return {
    accept(candidate: BackendEngineSnapshotDto): PlaybackSnapshotDto {
      if (candidate.queue.revision !== candidate.revision) {
        throw new Error("Engine snapshot revisions do not match");
      }
      if (!engineState) {
        engineState = candidate;
      } else {
        const dspExecution = mergeDspExecution(engineState.dspExecution, candidate.dspExecution);
        if (candidate.revision > engineState.revision) {
          engineState = { ...candidate, dspExecution };
        } else if (dspExecution !== engineState.dspExecution) {
          engineState = { ...engineState, dspExecution };
        }
      }
      if (!engineState) throw new Error("Playback state is not initialized");
      return adaptPlayback(engineState);
    },
    current(): PlaybackSnapshotDto {
      if (!engineState) throw new Error("Playback state is not initialized");
      return adaptPlayback(engineState);
    },
    acceptProgress(progress: BackendPlaybackProgressDto): "apply" | "ignore" | "resync" {
      if (!engineState || progress.revision > engineState.revision) return "resync";
      if (progress.revision < engineState.revision) return "ignore";
      engineState = {
        ...engineState,
        playback: {
          ...engineState.playback,
          positionMs: progress.positionMs,
          durationMs: progress.durationMs,
        },
      };
      return "apply";
    },
  };
}

function tauriBridge(): TauriBridgeContract {
  const engineGate = createEngineSnapshotGate();

  const invokeEngine = async (command: string, args?: Record<string, unknown>) =>
    engineGate.accept(await invoke<BackendEngineSnapshotDto>(command, args));

  return {
    async bootstrap() {
      const value = await invoke<BackendBootstrapDto>(TAURI_COMMANDS.bootstrap);
      return { playback: engineGate.accept(value.engine), settings: adaptSettings(value.settings), tasks: localTasks(value) };
    },
    async getPlayback() { return invokeEngine(TAURI_COMMANDS.playbackGetState); },
    async play(track, context = { kind: "manual", id: null }) {
      const request = track ? { track, context } : null;
      return invokeEngine(TAURI_COMMANDS.playbackPlay, { request });
    },
    async pause() { return invokeEngine(TAURI_COMMANDS.playbackPause); },
    async stop() { return invokeEngine(TAURI_COMMANDS.playbackStop); },
    async next() { return invokeEngine(TAURI_COMMANDS.playbackNext); },
    async previous() { return invokeEngine(TAURI_COMMANDS.playbackPrevious); },
    async setRepeatMode(mode) {
      const backendMode = { sequence: "sequential", all: "repeatAll", one: "repeatOne", shuffle: "shuffle" }[mode];
      return invokeEngine(TAURI_COMMANDS.playbackSetRepeatMode, { mode: backendMode });
    },
    async seek(positionMs) { return invokeEngine(TAURI_COMMANDS.playbackSeek, { request: { positionMs } }); },
    async setVolume(volume) { return invokeEngine(TAURI_COMMANDS.playbackSetVolume, { request: { volume } }); },
    async getSettings() { return adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsGet)); },
    async dspGetConfiguration() { return invoke<DspConfigurationDto>(TAURI_COMMANDS.dspGetConfiguration); },
    async dspConfigure(configuration) { return invoke<DspApplyResultDto>(TAURI_COMMANDS.dspConfigure, { request: { configuration } }); },
    async dspListPresets() { return invoke<DspPresetDto[]>(TAURI_COMMANDS.dspListPresets); },
    async dspApplyPreset(presetId, revision) { return invoke<DspApplyResultDto>(TAURI_COMMANDS.dspApplyPreset, { request: { presetId, revision } }); },
    async dspImportHse2(code, revision) { return invoke<DspApplyResultDto>(TAURI_COMMANDS.dspImportHse2, { request: { code, revision } }); },
    async dspExportHse2() { return invoke<DspHse2ExportDto>(TAURI_COMMANDS.dspExportHse2); },
    async updateSettings(patch) {
      if (patch.material !== undefined) localStorage.setItem(materialKey, patch.material);
      const request = settingsRequest(patch);
      if (Object.keys(request).length === 0) return { ...(await this.getSettings()), material: patch.material ?? getMaterial() };
      return { ...adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsUpdate, { request })), material: patch.material ?? getMaterial() };
    },
    async enqueue(track, position: QueueInsertPosition) { return invokeEngine(TAURI_COMMANDS.queueEnqueue, { request: { track, position } }); },
    async removeQueueItem(queueItemId) { return invokeEngine(TAURI_COMMANDS.queueRemove, { request: { queueItemId } }); },
    async reorderQueueItem(queueItemId, targetIndex) { return invokeEngine(TAURI_COMMANDS.queueReorder, { request: { queueItemId, targetIndex } }); },
    async clearQueue(scope) { return invokeEngine(scope === "all" ? TAURI_COMMANDS.queueClearAll : TAURI_COMMANDS.queueClearPlayNext); },
    async libraryOverview() { return invoke<LibraryOverviewDto>(TAURI_COMMANDS.libraryOverview); },
    async libraryQuery(search, cursor = null) {
      return invoke<LibraryPageDto>(TAURI_COMMANDS.libraryQueryTracks, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } });
    },
    async libraryQueryAlbums(search, cursor = null) { return invoke<EntityPageDto<LibraryAlbumDto>>(TAURI_COMMANDS.libraryQueryAlbums, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryArtists(search, cursor = null) { return invoke<EntityPageDto<LibraryArtistDto>>(TAURI_COMMANDS.libraryQueryArtists, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryFolders(search, cursor = null) { return invoke<EntityPageDto<LibraryFolderDto>>(TAURI_COMMANDS.libraryQueryFolders, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryQueryRecent(cursor = null) { return invoke<EntityPageDto<LibraryRecentDto>>(TAURI_COMMANDS.libraryQueryRecent, { page: { cursor, limit: 100 } }); },
    async libraryQueryPlaylists(search, cursor = null) { return invoke<EntityPageDto<LibraryPlaylistDto>>(TAURI_COMMANDS.libraryQueryPlaylists, { request: { search: search?.trim() || null, page: { cursor, limit: 100 } } }); },
    async libraryCreatePlaylist(name) { return invoke<LibraryPlaylistDto>(TAURI_COMMANDS.libraryCreatePlaylist, { request: { name } }); },
    async libraryRenamePlaylist(id, name) { return invoke<LibraryPlaylistDto>(TAURI_COMMANDS.libraryRenamePlaylist, { request: { id, name } }); },
    async libraryDeletePlaylist(id) { await invoke(TAURI_COMMANDS.libraryDeletePlaylist, { request: { id } }); },
    async libraryAddPlaylistTrack(playlistId, trackId) { await invoke(TAURI_COMMANDS.libraryAddPlaylistTrack, { request: { playlistId, trackId } }); },
    async libraryRemovePlaylistTrack(playlistId, trackId) { await invoke(TAURI_COMMANDS.libraryRemovePlaylistTrack, { request: { playlistId, trackId } }); },
    async libraryReorderPlaylistTrack(playlistId, trackId, targetPosition) { await invoke(TAURI_COMMANDS.libraryReorderPlaylistTrack, { request: { playlistId, trackId, targetPosition } }); },
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
    async neteaseMvs(cursor = null) { return invoke<NeteaseMvPageDto>(TAURI_COMMANDS.neteaseMvs, { request: { area: "全部", kind: "全部", order: "最热", page: { cursor, limit: 24 } } }); },
    async neteaseMvDetail(id) { return invoke<NeteaseMvDetailDto>(TAURI_COMMANDS.neteaseMvDetail, { request: { id } }); },
    async neteaseDjRadios(cursor = null) { return invoke<NeteaseDjPageDto>(TAURI_COMMANDS.neteaseDjRadios, { page: { cursor, limit: 20 } }); },
    async neteaseDjPrograms(radioId, cursor = null) { return invoke<NeteaseDjPageDto>(TAURI_COMMANDS.neteaseDjPrograms, { request: { radioId, ascending: false, page: { cursor, limit: 20 } } }); },
    async neteaseCharts() { return invoke<NeteaseChartDto[]>(TAURI_COMMANDS.neteaseCharts); },
    async neteaseNewSongs(areaId = 0) { return invoke<NeteaseTracksDto>(TAURI_COMMANDS.neteaseNewSongs, { request: { areaId } }); },
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
    async updaterUpdate(expectedVersion) { return invoke<boolean>(TAURI_COMMANDS.updaterUpdate, { expectedVersion }); },
    async shenzhenWeather() { return invoke<ShenzhenWeatherDto>(TAURI_COMMANDS.shenzhenWeather); },
    async resolveClose(action: CloseDecision, remember) { await invoke(TAURI_COMMANDS.windowResolveClose, { request: { action, remember } }); },
    createTelemetryTransport() {
      return createTauriTelemetryTransport({
        invoke,
        createChannel: (onmessage) => new Channel(onmessage),
        commands: {
          subscribe: TAURI_COMMANDS.telemetrySubscribe,
          acknowledge: TAURI_COMMANDS.telemetryAck,
          setActivity: TAURI_COMMANDS.telemetrySetActivity,
          close: TAURI_COMMANDS.telemetryClose,
        },
      });
    },
    async subscribe(handlers: BridgeEventHandlers): Promise<Unlisten> {
      const listeners: Unlisten[] = [];
      const add = async <T>(event: string, handler: (event: Event<T>) => void) => { listeners.push(await listen<T>(event, handler)); };
      try {
        await add<BackendEngineSnapshotDto>(TAURI_EVENTS.engineSnapshotChanged, ({ payload }) => handlers.playbackChanged?.(engineGate.accept(payload)));
        await add<BackendPlaybackProgressDto>(TAURI_EVENTS.playbackProgress, ({ payload }) => {
          const decision = engineGate.acceptProgress(payload);
          if (decision === "ignore") return;
          if (decision === "resync") {
            void invokeEngine(TAURI_COMMANDS.playbackGetState).then((playback) => handlers.playbackChanged?.(playback)).catch(() => undefined);
            return;
          }
          handlers.playbackProgress?.(payload);
        });
        await add<BackendScanProgressDto>(TAURI_EVENTS.libraryScanProgress, ({ payload }) => handlers.scanProgress?.(payload));
        await add<BackendSettingsDto>(TAURI_EVENTS.settingsChanged, ({ payload }) => handlers.settingsChanged?.(adaptSettings(payload)));
        await add<BackendCacheStatusDto>(TAURI_EVENTS.cacheStatusChanged, ({ payload }) => handlers.cacheStatusChanged?.(payload));
        await add<BackendNeteaseStatusDto>(TAURI_EVENTS.neteaseStatusChanged, ({ payload }) => handlers.neteaseStatusChanged?.(payload));
        await add<BackendDspConfigurationRejectedDto>(TAURI_EVENTS.dspConfigurationRejected, ({ payload }) => handlers.dspConfigurationRejected?.(adaptDspConfigurationRejected(payload)));
        await add<BackendDspProcessingFaultDto>(TAURI_EVENTS.dspProcessingFault, ({ payload }) => handlers.dspProcessingFault?.({
          ...payload,
          revision: BigInt(payload.revision),
          streamFrame: BigInt(payload.streamFrame),
        }));
        await add<BackendCloseRequestedDto>(TAURI_EVENTS.closeRequested, ({ payload }) => handlers.closeRequested?.(payload));
      } catch (error) {
        listeners.forEach((unlisten) => unlisten());
        throw error;
      }
      return () => listeners.splice(0).forEach((unlisten) => unlisten());
    },
  };
}

export const bridge: TauriBridgeContract = tauriBridge();
