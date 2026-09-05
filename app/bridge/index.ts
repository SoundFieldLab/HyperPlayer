import { fallbackCover } from "../artwork";
import * as netease from "../services/netease/neteaseService";
import { playbackService as playback } from "../services/playback/playbackService";
import { dspService as dsp } from "../services/dsp/dspService";
import { cacheService as cache } from "../services/cache/cacheService";
import { lyricsService as lyrics } from "../services/lyrics/lyricsService";
import { weatherService as weather } from "../services/weather/weatherService";
import { createHseTelemetryTransport } from "../visualization/telemetry/hse-transport";
import { windowRoot } from "../window-root";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type Event } from "@tauri-apps/api/event";
import type {
  AppSettingsDto,
  BackendBootstrapDto,
  BackendCloseRequestedDto,
  BackendScanProgressDto,
  BackendSettingsDto,
  BackendTrackDto,
  BackendTrackRefDto,
  BackgroundTaskDto,
  BridgeContract,
  BridgeEventHandlers,
  CloseDecision,
  EntityPageDto,
  LibraryAlbumDto,
  LibraryArtistDto,
  LibraryArtworkDto,
  LibraryFolderDto,
  LibraryLocationDto,
  LibraryLocationSelectionDto,
  MediaButton,
  LibraryMutationResultDto,
  LibraryOverviewDto,
  LibraryPageDto,
  LibraryPlaylistDto,
  LibraryRecentDto,
  NeteaseChartDto,
  NeteaseCommentPageDto,
  NeteaseCommentResource,
  NeteaseHomeDto,
  NeteaseLoginStateDto,
  NeteaseMutationDto,
  NeteaseNewSongsDto,
  NeteaseSearchKind,
  NeteaseSearchPageDto,
  NeteaseSearchSuggestionsDto,
  PlaybackSnapshotDto,
  TaskAcceptedDto,
  TrackDto,
  Unlisten,
  UpdateCheckDto,
  UpdaterStatusDto,
  WindowKind,
  WindowsIntegrationStatusDto,
} from "./contracts";

export const TAURI_COMMANDS = {
  bootstrap: "bootstrap",
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
  settingsGet: "settings_get",
  settingsUpdate: "settings_update",
  windowShow: "window_show",
  windowClose: "window_close",
  windowHide: "window_hide",
  windowSetAlwaysOnTop: "window_set_always_on_top",
  desktopLyricsSetClickThrough: "desktop_lyrics_set_click_through",
  windowResolveClose: "window_resolve_close",
  windowsIntegrationStatus: "windows_integration_status",
  windowsEnableMediaControls: "windows_enable_media_controls",
  windowsRegisterFileAssociations: "windows_register_file_associations",
  updaterStatus: "updater_status",
  updaterCheck: "updater_check",
  updaterUpdate: "updater_update",
  credentialGet: "credential_get",
  credentialSet: "credential_set",
  smtcUpdateMetadata: "smtc_update_metadata",
  smtcUpdatePlaybackState: "smtc_update_playback_state",
  smtcUpdatePosition: "smtc_update_position",
  logWeb: "log_web",
} as const;

export const TAURI_EVENTS = {
  libraryScanProgress: "hyperplayer://library/scan-progress",
  settingsChanged: "hyperplayer://settings/changed",
  closeRequested: "hyperplayer://window/close-requested",
  mediaKeyPressed: "hyperplayer://windows/media-key-pressed",
  updaterStatusChanged: "hyperplayer://updater/status-changed",
  playbackBroadcast: "hyperplayer://playback/broadcast",
} as const;

const materialKey = "hyperplayer.material";
const getMaterial = (): AppSettingsDto["material"] => localStorage.getItem(materialKey) === "atmosphere" ? "atmosphere" : "clean";

function quality(value: string | null): TrackDto["quality"] {
  return value === "Hi-Res" || value === "无损" || value === "极高" ? value : "标准";
}

async function resolveTrackDto(ref: BackendTrackRefDto): Promise<TrackDto> {
  if (ref.source === "local") {
    const page = await invoke<LibraryPageDto>(TAURI_COMMANDS.libraryQueryTracks, { request: { search: ref.id, page: { cursor: null, limit: 100 } } });
    const found = page.items.find((item) => item.trackRef.id === ref.id);
    if (!found) throw new Error("本地曲库未找到该曲目");
    return adaptTrack(found);
  }
  const detail = await netease.getSongDetail(Number(ref.id));
  if (!detail) throw new Error("网易云未找到该曲目");
  return {
    id: String(detail.id),
    title: detail.name,
    artists: detail.artists.map((artist) => artist.name),
    album: detail.album.name,
    durationMs: detail.dt,
    source: "netease",
    entitlement: "free",
    quality: "标准",
    cache: "none",
    coverSeed: detail.coverUrl ?? "",
  };
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
    coverSeed: track.coverUrl ?? fallbackCover(String(fallbackIndex)),
  };
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
    dsp: settings.dsp ?? null,
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
  return {
    async bootstrap() {
      // 网易云会话恢复（DPAPI 凭据）+ 匿名 MUSIC_A 引导：不阻塞主引导，失败仅告警。
      void netease.bootstrapNetease().catch(() => undefined);
      const value = await invoke<BackendBootstrapDto>(TAURI_COMMANDS.bootstrap);
      netease.setNeteaseDomainEnabled(adaptSettings(value.settings).neteaseEnabled);
      return {
        app: value.app,
        settings: adaptSettings(value.settings),
        tasks: localTasks(value),
        playback: playback.getPlayback(),
      };
    },
    async getSettings() { return adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsGet)); },
    async updateSettings(patch) {
      if (patch.material !== undefined) localStorage.setItem(materialKey, patch.material);
      const request = settingsRequest(patch);
      if (Object.keys(request).length === 0) return { ...(await this.getSettings()), material: patch.material ?? getMaterial() };
      const updated = adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsUpdate, { request }));
      netease.setNeteaseDomainEnabled(updated.neteaseEnabled);
      return { ...updated, material: patch.material ?? getMaterial() };
    },
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
    async windowShow(kind: WindowKind) { await invoke(TAURI_COMMANDS.windowShow, { request: { kind } }); },
    async windowHide(kind: WindowKind) { await invoke(TAURI_COMMANDS.windowHide, { request: { kind } }); },
    async windowClose(kind) { await invoke(TAURI_COMMANDS.windowClose, { request: { kind } }); },
    async windowSetAlwaysOnTop(kind: WindowKind, enabled) { await invoke(TAURI_COMMANDS.windowSetAlwaysOnTop, { request: { kind, enabled } }); },
    async desktopLyricsSetClickThrough(enabled) { await invoke(TAURI_COMMANDS.desktopLyricsSetClickThrough, { request: { kind: "desktopLyrics", enabled } }); },
    async windowsIntegrationStatus() { return invoke<WindowsIntegrationStatusDto>(TAURI_COMMANDS.windowsIntegrationStatus); },
    async windowsEnableMediaControls() { await invoke(TAURI_COMMANDS.windowsEnableMediaControls); },
    async windowsRegisterFileAssociations(extensions) { await invoke(TAURI_COMMANDS.windowsRegisterFileAssociations, { request: { extensions } }); },
    async updaterStatus() { return invoke<UpdaterStatusDto>(TAURI_COMMANDS.updaterStatus); },
    async updaterCheck() { return invoke<UpdateCheckDto>(TAURI_COMMANDS.updaterCheck); },
    async updaterUpdate(expectedVersion) { return invoke<boolean>(TAURI_COMMANDS.updaterUpdate, { expectedVersion }); },
    async credentialGet() { return invoke<string | null>(TAURI_COMMANDS.credentialGet); },
    async credentialSet(payload) { await invoke(TAURI_COMMANDS.credentialSet, { request: { payload } }); },
    async smtcUpdateMetadata(metadata) { await invoke(TAURI_COMMANDS.smtcUpdateMetadata, { request: metadata }); },
    async smtcUpdatePlaybackState(state) { await invoke(TAURI_COMMANDS.smtcUpdatePlaybackState, { request: { state } }); },
    async smtcUpdatePosition(position) { await invoke(TAURI_COMMANDS.smtcUpdatePosition, { request: position }); },
    // ---- 网易云服务层委托（D34：UI 保留、服务层实现，不经过 Tauri command） ----
    async neteaseStatus() { return netease.neteaseStatus(); },
    async neteaseAccount() { return netease.neteaseAccount(); },
    async neteaseStartQrLogin() { return netease.neteaseStartQrLogin(); },
    async neteasePollQrLogin(loginId) { return netease.neteasePollQrLogin(loginId); },
    async neteaseLogout() { return netease.neteaseLogout(); },
    async neteaseHome() { return netease.neteaseHome(); },
    async neteaseBanner() { return netease.neteaseBanner(); },
    async neteaseCharts() { return netease.neteaseCharts(); },
    async neteaseNewSongs() { return netease.neteaseNewSongs(); },
    async neteaseExploreNext(limit, batch, exclude) { return netease.neteaseExploreNext(limit, batch, exclude); },
    async neteaseSearch(keywords, kind) { return netease.neteaseSearch(keywords, kind); },
    async neteaseSearchHot() { return netease.neteaseSearchHot(); },
    async neteaseSearchSuggest(keywords) { return netease.neteaseSearchSuggest(keywords); },
    async neteasePlaylistDetail(id) { return netease.neteasePlaylistDetail(id); },
    async neteaseAlbumDetail(id) { return netease.neteaseAlbumDetail(id); },
    async neteaseArtistDetail(id) { return netease.neteaseArtistDetail(id); },
    async neteaseRelatedPlaylists(id) { return netease.neteaseRelatedPlaylists(id); },
    async neteaseSimilarArtists(id) { return netease.neteaseSimilarArtists(id); },
    async neteasePlaymodeIntelligenceList(songId, playlistId) { return netease.neteasePlaymodeIntelligenceList(songId, playlistId); },
    async neteaseComments(resource, resourceId) { return netease.neteaseComments(resource, resourceId); },
    async neteasePrepareMutation(mutation) { return netease.neteasePrepareMutation(mutation); },
    async neteaseCommitMutation(token, confirmed) { return netease.neteaseCommitMutation(token, confirmed); },
    async neteaseFavorites() { return netease.neteaseFavorites(); },
    async neteaseCloud() { return netease.neteaseCloud(); },
    async neteaseAlbumSublist() { return netease.neteaseAlbumSublist(); },
    async neteaseArtistSublist() { return netease.neteaseArtistSublist(); },
    async neteaseMvSublist() { return netease.neteaseMvSublist(); },
    async neteaseDjSublist() { return netease.neteaseDjSublist(); },
    async neteaseMvs(cursor) { return netease.neteaseMvs(cursor); },
    async neteaseMvDetail(id) { return netease.neteaseMvDetail(id); },
    async neteaseMvPlayback(id) { return netease.neteaseMvPlayback(id); },
    async neteaseDjRadios(cursor) { return netease.neteaseDjRadios(cursor); },
    async neteaseDjPrograms(radioId, cursor) { return netease.neteaseDjPrograms(radioId, cursor); },
    async neteaseDjCategories() { return netease.neteaseDjCategories(); },
    async neteaseDjRecommend() { return netease.neteaseDjRecommend(); },
    async neteaseDjProgramToplist() { return netease.neteaseDjProgramToplist(); },
    async neteaseNotices() { return netease.neteaseNotices(); },
    async neteaseFollowedEvents() { return netease.neteaseFollowedEvents(); },
    async neteaseFollows(userId) { return netease.neteaseFollows(userId); },
    async neteaseListenTotal() { return netease.neteaseListenTotal(); },
    async neteaseListenReport(period) { return netease.neteaseListenReport(period); },
    async neteaseListenSongRank(period) { return netease.neteaseListenSongRank(period); },
    async neteaseScrobble(payload) { return netease.neteaseScrobble(payload); },
    async neteaseImage(src) { return netease.neteaseImage(src); },
    async neteaseUpdatePlaylistCover(playlistId, imageBase64, mimeType) { return netease.neteaseUpdatePlaylistCover(playlistId, imageBase64, mimeType); },
    // ---- 播放服务（D34：WebView 播放链） ----
    async getPlayback() { return playback.getPlayback(); },
    async play(track, context) {
      if (track) {
        const fullTrack = await resolveTrackDto(track);
        return playback.playTrack(fullTrack, context);
      }
      return playback.play();
    },
    async pause() { return playback.pause(); },
    async stop() { return playback.stop(); },
    async next() { return playback.next(); },
    async previous() { return playback.previous(); },
    async seek(positionMs) { return playback.seek(positionMs); },
    async setVolume(volume) { return playback.setVolume(volume); },
    async setRepeatMode(repeat) { return playback.setRepeatMode(repeat); },
    async enqueue(track, position) { return playback.enqueue(track, position); },
    async removeQueueItem(queueItemId) { return playback.removeQueueItem(queueItemId); },
    async reorderQueueItem(queueItemId, targetIndex) { return playback.reorderQueueItem(queueItemId, targetIndex); },
    async clearQueue(scope) { return playback.clearQueue(scope); },
    // ---- DSP 服务（D34：HSE 控制面） ----
    async dspGetConfiguration() { return dsp.getConfiguration(); },
    async dspListPresets() { return dsp.listPresets(); },
    async dspConfigure(request) { return dsp.configure(request); },
    async dspApplyPreset(presetId, revision) { return dsp.applyPreset(presetId, revision); },
    async dspImportHse2(code, revision) { return dsp.importHse2(code, revision); },
    async dspExportHse2() { return dsp.exportHse2(); },
    // ---- 歌词 / 缓存 / 天气 / 遥测 ----
    async lyricsGet(request) { return lyrics.get(request); },
    async cacheStatus(request) { return cache.status(request); },
    async cacheTrack(request, quality) { return cache.cacheTrack(request, quality); },
    async cacheRemove(request) { return cache.remove(request); },
    async cacheClear() { return cache.clear(); },
    async cacheStats() { return cache.stats(); },
    async shenzhenWeather() { return weather.shenzhen(); },
    createTelemetryTransport() { return createHseTelemetryTransport(); },
    async logWeb(level, message) { await invoke(TAURI_COMMANDS.logWeb, { request: { level, message } }); },
    async resolveClose(action: CloseDecision, remember) { await invoke(TAURI_COMMANDS.windowResolveClose, { request: { action, remember } }); },
    async subscribe(handlers: BridgeEventHandlers): Promise<Unlisten> {
      const listeners: Unlisten[] = [];
      const add = async <T>(event: string, handler: (event: Event<T>) => void) => { listeners.push(await listen<T>(event, handler)); };
      try {
        // D35 Q18：主窗口权威——播放服务本地事件 + 跨窗口广播；辅助窗口纯订阅广播。
        if (windowRoot(window.location.search) === "main") {
          let lastSnapshot: PlaybackSnapshotDto | null = null;
          let lastBroadcastAt = 0;
          const broadcast = (snapshot: PlaybackSnapshotDto) => {
            lastSnapshot = snapshot;
            void emit(TAURI_EVENTS.playbackBroadcast, snapshot).catch(() => undefined);
          };
          const playbackUnlisten = playback.subscribe({
            onChanged: (snapshot) => {
              handlers.playbackChanged?.(snapshot);
              broadcast(snapshot);
            },
            onQueueChanged: (snapshot) => {
              handlers.queueChanged?.(snapshot);
              broadcast(snapshot);
            },
            onProgress: (revision, positionMs, durationMs) => {
              handlers.playbackProgress?.({ revision, positionMs, durationMs });
              // 辅助窗口打开后 ≤1s 收到完整快照：进度路径承担 D35 的 1Hz 广播。
              const now = Date.now();
              if (lastSnapshot && now - lastBroadcastAt >= 1000) {
                lastBroadcastAt = now;
                void emit(TAURI_EVENTS.playbackBroadcast, lastSnapshot).catch(() => undefined);
              }
            },
            onFault: (fault) => handlers.dspProcessingFault?.(fault),
          });
          listeners.push(playbackUnlisten);
        } else {
          await add<PlaybackSnapshotDto>(TAURI_EVENTS.playbackBroadcast, ({ payload }) => handlers.playbackChanged?.(payload));
        }
        await add<BackendScanProgressDto>(TAURI_EVENTS.libraryScanProgress, ({ payload }) => handlers.scanProgress?.(payload));
        await add<BackendSettingsDto>(TAURI_EVENTS.settingsChanged, ({ payload }) => {
          const settings = adaptSettings(payload);
          netease.setNeteaseDomainEnabled(settings.neteaseEnabled);
          handlers.settingsChanged?.(settings);
        });
        await add<BackendCloseRequestedDto>(TAURI_EVENTS.closeRequested, ({ payload }) => handlers.closeRequested?.(payload));
        await add<{ button: string }>(TAURI_EVENTS.mediaKeyPressed, ({ payload }) => {
          handlers.mediaKeyPressed?.(payload.button as MediaButton);
        });
      } catch (error) {
        listeners.forEach((unlisten) => unlisten());
        throw error;
      }
      return () => listeners.splice(0).forEach((unlisten) => unlisten());
    },
  };
}

export const bridge: BridgeContract = tauriBridge();