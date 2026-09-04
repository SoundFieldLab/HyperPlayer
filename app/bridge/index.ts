import { fallbackCover } from "../artwork";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import type {
  AppSettingsDto,
  BackendBootstrapDto,
  BackendCloseRequestedDto,
  BackendScanProgressDto,
  BackendSettingsDto,
  BackendTrackDto,
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
  LibraryMutationResultDto,
  LibraryOverviewDto,
  LibraryPageDto,
  LibraryPlaylistDto,
  LibraryRecentDto,
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
  logWeb: "log_web",
} as const;

export const TAURI_EVENTS = {
  libraryScanProgress: "hyperplayer://library/scan-progress",
  settingsChanged: "hyperplayer://settings/changed",
  closeRequested: "hyperplayer://window/close-requested",
  mediaKeyPressed: "hyperplayer://windows/media-key-pressed",
  updaterStatusChanged: "hyperplayer://updater/status-changed",
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
      const value = await invoke<BackendBootstrapDto>(TAURI_COMMANDS.bootstrap);
      return { app: value.app, settings: adaptSettings(value.settings), tasks: localTasks(value) };
    },
    async getSettings() { return adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsGet)); },
    async updateSettings(patch) {
      if (patch.material !== undefined) localStorage.setItem(materialKey, patch.material);
      const request = settingsRequest(patch);
      if (Object.keys(request).length === 0) return { ...(await this.getSettings()), material: patch.material ?? getMaterial() };
      return { ...adaptSettings(await invoke<BackendSettingsDto>(TAURI_COMMANDS.settingsUpdate, { request })), material: patch.material ?? getMaterial() };
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
    async logWeb(level, message) { await invoke(TAURI_COMMANDS.logWeb, { request: { level, message } }); },
    async resolveClose(action: CloseDecision, remember) { await invoke(TAURI_COMMANDS.windowResolveClose, { request: { action, remember } }); },
    async subscribe(handlers: BridgeEventHandlers): Promise<Unlisten> {
      const listeners: Unlisten[] = [];
      const add = async <T>(event: string, handler: (event: Event<T>) => void) => { listeners.push(await listen<T>(event, handler)); };
      try {
        await add<BackendScanProgressDto>(TAURI_EVENTS.libraryScanProgress, ({ payload }) => handlers.scanProgress?.(payload));
        await add<BackendSettingsDto>(TAURI_EVENTS.settingsChanged, ({ payload }) => handlers.settingsChanged?.(adaptSettings(payload)));
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