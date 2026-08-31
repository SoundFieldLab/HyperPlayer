import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));
vi.mock("./player/Player", () => ({ ExpandedPlayer: () => null, PlayerDock: () => null }));

const storage = (() => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage;
})();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  storage.clear();
  vi.resetModules();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("content-domain navigation history", () => {
  it("restores independent detail-aware back and forward stacks per domain", async () => {
    const { useAppStore } = await import("./store");
    const store = useAppStore.getState();

    store.navigate("playlist", 101);
    store.navigate("album", 202);
    store.setDomain("local");
    store.navigate("albums");
    store.navigate("albums", "local-album-303", "album");
    store.back();

    expect(useAppStore.getState()).toMatchObject({ domain: "local", view: "albums", detailId: null, detailKind: null });
    store.setDomain("netease");
    expect(useAppStore.getState()).toMatchObject({ domain: "netease", view: "album", detailId: 202, detailKind: null });

    useAppStore.getState().back();
    expect(useAppStore.getState()).toMatchObject({ view: "playlist", detailId: 101, detailKind: null });
    useAppStore.getState().forward();
    expect(useAppStore.getState()).toMatchObject({ view: "album", detailId: 202, detailKind: null });

    useAppStore.getState().setDomain("local");
    useAppStore.getState().forward();
    expect(useAppStore.getState()).toMatchObject({ view: "albums", detailId: "local-album-303", detailKind: "album" });
  });

  it("keeps string local entities distinct from numeric NetEase details across domain switches", async () => {
    const { useAppStore } = await import("./store");

    useAppStore.getState().navigate("playlist", 42);
    useAppStore.getState().setDomain("local");
    useAppStore.getState().navigate("folders");
    useAppStore.getState().navigate("folders", "folder:C:/Music/42", "folder");
    useAppStore.getState().setDomain("netease");

    expect(useAppStore.getState()).toMatchObject({ view: "playlist", detailId: 42, detailKind: null });
    useAppStore.getState().setDomain("local");
    expect(useAppStore.getState()).toMatchObject({ view: "folders", detailId: "folder:C:/Music/42", detailKind: "folder" });

    useAppStore.getState().back();
    expect(useAppStore.getState()).toMatchObject({ view: "folders", detailId: null, detailKind: null });
    useAppStore.getState().forward();
    expect(useAppStore.getState()).toMatchObject({ view: "folders", detailId: "folder:C:/Music/42", detailKind: "folder" });
  });

  it.each([
    ["albums", "album", "album:550e8400-e29b-41d4-a716-446655440010"],
    ["artists", "artist", "artist:550e8400-e29b-41d4-a716-446655440011"],
    ["folders", "folder", "folder:E:/Music/Live"],
    ["playlists", "playlist", "playlist:550e8400-e29b-41d4-a716-446655440012"],
  ] as const)("stores %s details with string IDs and entity kind", async (view, detailKind, detailId) => {
    const { useAppStore } = await import("./store");

    useAppStore.getState().setDomain("local");
    useAppStore.getState().navigate(view);
    useAppStore.getState().navigate(view, detailId, detailKind);

    expect(useAppStore.getState()).toMatchObject({ domain: "local", view, detailId, detailKind });
    expect(useAppStore.getState().navigation.local.current).toEqual({ view, detailId, detailKind });
  });

  it("clears only the active forward stack and caps history at 20 entries", async () => {
    const { useAppStore } = await import("./store");

    useAppStore.getState().navigate("search");
    useAppStore.getState().navigate("playlist", 1);
    useAppStore.getState().back();
    useAppStore.getState().setDomain("local");
    useAppStore.getState().navigate("songs");
    useAppStore.getState().navigate("albums");
    useAppStore.getState().back();
    useAppStore.getState().navigate("artists");

    expect(useAppStore.getState().navigation.local.forward).toEqual([]);
    expect(useAppStore.getState().navigation.netease.forward).toEqual([{ view: "playlist", detailId: 1, detailKind: null }]);

    useAppStore.getState().setDomain("netease");
    for (let detailId = 2; detailId <= 25; detailId += 1) useAppStore.getState().navigate("playlist", detailId);
    expect(useAppStore.getState().navigation.netease.back).toHaveLength(20);
    expect(useAppStore.getState().navigation.netease.back[0]).toEqual({ view: "playlist", detailId: 5, detailKind: null });
  });

  it("does not mutate playback, queue-bearing state, or overlays during traversal", async () => {
    const { useAppStore } = await import("./store");
    const playback = { marker: "shared-playback" } as never;
    useAppStore.setState({ playback, overlay: "queue", expandedPlayer: true, searchOpen: true });
    useAppStore.getState().navigate("album", 9);

    const shared = () => {
      const state = useAppStore.getState();
      return { playback: state.playback, overlay: state.overlay, expandedPlayer: state.expandedPlayer, searchOpen: state.searchOpen };
    };
    const before = shared();
    useAppStore.getState().back();
    expect(shared()).toEqual(before);
    useAppStore.getState().forward();
    expect(shared()).toEqual(before);
    useAppStore.getState().setDomain("local");
    expect(shared()).toEqual(before);
  });

  it("enables and invokes both titlebar history controls", async () => {
    const React = await import("react");
    const { useAppStore } = await import("./store");
    const { Titlebar } = await import("./shell/Navigation");
    useAppStore.getState().navigate("album", 7);
    useAppStore.getState().back();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(React.createElement(Titlebar)));
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="返回"]');
    const forward = container.querySelector<HTMLButtonElement>('button[aria-label="前进"]');
    expect(back?.disabled).toBe(true);
    expect(forward?.disabled).toBe(false);

    await act(async () => forward?.click());
    expect(useAppStore.getState()).toMatchObject({ view: "album", detailId: 7 });
    expect(back?.disabled).toBe(false);
  }, 15_000);

  it("maps Alt+Left and Alt+Right to history while preserving Escape priority", async () => {
    const React = await import("react");
    const { useAppStore } = await import("./store");
    const { default: App } = await import("./App");
    const init = vi.fn(async () => undefined);
    const dispose = vi.fn();
    useAppStore.setState({ ready: true, onboarding: true, init, dispose });
    useAppStore.getState().navigate("playlist", 44);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(App)));

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true })));
    expect(useAppStore.getState()).toMatchObject({ view: "home", detailId: null });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true })));
    expect(useAppStore.getState()).toMatchObject({ view: "playlist", detailId: 44 });

    await act(async () => { useAppStore.setState({ searchOpen: true, overlay: "queue", expandedPlayer: true }); });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(useAppStore.getState()).toMatchObject({ searchOpen: false, overlay: "queue", expandedPlayer: true });
  });
});
