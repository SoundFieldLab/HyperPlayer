import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from '../../src/stores/slices/nav';
import { useUiStore } from '../../src/stores/slices/ui';

const entry = (routeId: string, entityId?: string) => ({ routeId, entityId });

describe('nav store', () => {
  beforeEach(() => {
    useNavStore.setState({
      activeDomain: 'netease',
      histories: {
        netease: { entries: [], currentIndex: -1 },
        local: { entries: [], currentIndex: -1 },
      },
      currentEntry: null,
    });
  });

  it('navigates within the active domain and writes params.segment', () => {
    useNavStore.getState().navigate(entry('home'), 'discover');
    useNavStore.getState().navigate(entry('playlist', '42'), 'detail');

    const state = useNavStore.getState();
    expect(state.currentEntry).toEqual({
      routeId: 'playlist',
      entityId: '42',
      params: { segment: 'detail' },
    });
    expect(state.histories.netease).toEqual({
      entries: [
        { routeId: 'home', entityId: undefined, params: { segment: 'discover' } },
        { routeId: 'playlist', entityId: '42', params: { segment: 'detail' } },
      ],
      currentIndex: 1,
    });
  });

  it('moves back and forward and truncates the forward branch', () => {
    const nav = useNavStore.getState();
    nav.navigate(entry('home'));
    nav.navigate(entry('search'));
    nav.navigate(entry('album', '7'));

    expect(nav.back()).toEqual(entry('search'));
    expect(nav.forward()).toEqual(entry('album', '7'));
    expect(nav.back()).toEqual(entry('search'));
    nav.navigate(entry('artist', '9'));
    expect(nav.forward()).toBeNull();
    expect(useNavStore.getState().histories.netease.entries).toEqual([
      entry('home'),
      entry('search'),
      entry('artist', '9'),
    ]);
  });

  it('keeps independent history pointers for netease and local domains', () => {
    const nav = useNavStore.getState();
    nav.navigate('netease', entry('netease-home'));
    nav.navigate('local', entry('folders'));
    nav.navigate('local', entry('folder', 'music'));
    nav.switchDomain('netease');

    expect(useNavStore.getState().currentEntry).toEqual(entry('netease-home'));
    expect(nav.back()).toBeNull();
    nav.switchDomain('local');
    expect(useNavStore.getState().currentEntry).toEqual(entry('folder', 'music'));
    expect(nav.back()).toEqual(entry('folders'));
  });
});

describe('ui overlay store', () => {
  beforeEach(() => useUiStore.setState({ overlay: { kind: 'none' } }));

  it('stores transient overlays without navigation entries', () => {
    useUiStore.getState().setOverlay({ kind: 'modal', id: 'login' });
    expect(useUiStore.getState().overlay).toEqual({ kind: 'modal', id: 'login' });
    useUiStore.getState().clearOverlay();
    expect(useUiStore.getState().overlay).toEqual({ kind: 'none' });
  });
});
