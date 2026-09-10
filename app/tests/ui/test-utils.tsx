import { render, type RenderOptions } from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';
import { vi } from 'vitest';
import { ServicesProvider } from '../../src/app/providers/ServicesProvider';
import type { Services } from '../../src/app/wiring';

export function createFakeServices(overrides: Partial<Services> = {}): Services {
  const services = {
    library: { queryTracks: vi.fn().mockResolvedValue([]), getTrack: vi.fn().mockResolvedValue(null), listAlbums: vi.fn().mockResolvedValue([]), listArtists: vi.fn().mockResolvedValue([]), listFolders: vi.fn().mockResolvedValue([]), listPlaylists: vi.fn().mockResolvedValue([]) },
    covers: { getCoverPath: vi.fn().mockResolvedValue(null) },
    netease: { route: vi.fn().mockResolvedValue({ body: { result: [], songs: [], list: [] } }) },
    cloudPlaylistSync: { listCached: vi.fn().mockResolvedValue([]), syncAll: vi.fn().mockResolvedValue({ playlists: 0, tracks: 0 }) },
    playHistory: { listRecent: vi.fn().mockResolvedValue([]) },
    audio: {
      listOutputDevices: vi.fn().mockResolvedValue([]),
      setOutputVolume: vi.fn(),
      setSinkId: vi.fn().mockResolvedValue(undefined),
    },
    player: {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      prev: vi.fn().mockResolvedValue(undefined),
      seek: vi.fn().mockResolvedValue(undefined),
    },
    settings: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  } as unknown as Services;

  return services;
}

export function renderWithServices(
  ui: ReactElement,
  services: Services = createFakeServices(),
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  function Wrapper({ children }: PropsWithChildren) {
    return <ServicesProvider services={services}>{children}</ServicesProvider>;
  }

  return render(ui, { wrapper: Wrapper, ...options });
}
