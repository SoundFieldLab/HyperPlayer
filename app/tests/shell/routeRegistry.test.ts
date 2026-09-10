import { describe, expect, it } from 'vitest';
import {
  NOT_FOUND_ROUTE_ID,
  ROUTE_IDS,
  resolveRoute,
  routeRegistry,
} from '../../src/shell/routeRegistry';

const documentedRouteIds = [
  'netease-home',
  'search',
  'netease-library',
  'discover',
  'recent',
  'netease-playlist',
  'netease-album',
  'netease-artist',
  'netease-mv',
  'account',
  'local-home',
  'local-songs',
  'local-albums',
  'local-artists',
  'local-folders',
  'local-playlists',
  'local-album',
  'local-artist',
  'local-playlist',
  'dsp',
  'settings',
] as const;

describe('route registry contract', () => {
  it('registers every documented page route', () => {
    expect(ROUTE_IDS).toEqual(expect.arrayContaining([...documentedRouteIds]));
    for (const routeId of documentedRouteIds) {
      expect(routeRegistry[routeId]).toBeDefined();
      expect(routeRegistry[routeId].routeId).toBe(routeId);
      expect(typeof routeRegistry[routeId].component).toBe('function');
    }
  });

  it('resolves registered route definitions without changing their identity', () => {
    const definition = resolveRoute('search');

    expect(definition).toBe(routeRegistry.search);
    expect(definition.kind).toBe('page');
    expect(definition.domain).toBe('netease');
  });

  it('returns an explicit recoverable NotFound definition for unknown routes', () => {
    const definition = resolveRoute('route-added-by-a-newer-version');

    expect(definition.routeId).toBe(NOT_FOUND_ROUTE_ID);
    expect(definition.kind).toBe('not-found');
    expect(definition.component).toBe(routeRegistry[NOT_FOUND_ROUTE_ID].component);
  });
});
