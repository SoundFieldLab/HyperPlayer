import { create } from 'zustand';

export type NavDomain = 'netease' | 'local';

export interface NavEntry {
  routeId: string;
  entityId?: string;
  params?: Record<string, unknown>;
  snapshot?: unknown;
}

export interface NavDomainHistory {
  entries: NavEntry[];
  currentIndex: number;
}

type Set = (
  partial:
    | Partial<NavSlice>
    | ((state: NavSlice) => Partial<NavSlice>),
) => void;

export interface NavSlice {
  activeDomain: NavDomain;
  histories: Record<NavDomain, NavDomainHistory>;
  currentEntry: NavEntry | null;

  navigate(entry: NavEntry, segment?: string): void;
  navigate(domain: NavDomain, entry: NavEntry, segment?: string): void;
  back(): NavEntry | null;
  forward(): NavEntry | null;
  switchDomain(domain: NavDomain): void;
}

const emptyHistory = (): NavDomainHistory => ({
  entries: [],
  currentIndex: -1,
});

const initialHistories = (): Record<NavDomain, NavDomainHistory> => ({
  netease: emptyHistory(),
  local: emptyHistory(),
});

const entryWithSegment = (entry: NavEntry, segment?: string): NavEntry => {
  if (segment === undefined) return entry;
  return {
    ...entry,
    params: { ...entry.params, segment },
  };
};

export const createNavSlice = (set: Set): NavSlice => ({
  activeDomain: 'netease',
  histories: initialHistories(),
  currentEntry: null,

  navigate: (...args: [NavEntry, string?] | [NavDomain, NavEntry, string?]) =>
    set((state) => {
      const [domain, entry, segment] =
        typeof args[0] === 'string'
          ? [args[0], args[1], args[2]]
          : [state.activeDomain, args[0], args[1]];
      if (!entry) return {};

      const nextEntry = entryWithSegment(entry, segment);
      const history = state.histories[domain];
      const entries = history.entries.slice(0, history.currentIndex + 1);
      entries.push(nextEntry);
      const nextHistory = { entries, currentIndex: entries.length - 1 };
      return {
        activeDomain: domain,
        histories: { ...state.histories, [domain]: nextHistory },
        currentEntry: nextEntry,
      };
    }),

  back: () => {
    let result: NavEntry | null = null;
    set((state) => {
      const history = state.histories[state.activeDomain];
      if (history.currentIndex <= 0) return {};
      const currentIndex = history.currentIndex - 1;
      result = history.entries[currentIndex] ?? null;
      return {
        histories: {
          ...state.histories,
          [state.activeDomain]: { ...history, currentIndex },
        },
        currentEntry: result,
      };
    });
    return result;
  },

  forward: () => {
    let result: NavEntry | null = null;
    set((state) => {
      const history = state.histories[state.activeDomain];
      if (history.currentIndex >= history.entries.length - 1) return {};
      const currentIndex = history.currentIndex + 1;
      result = history.entries[currentIndex] ?? null;
      return {
        histories: {
          ...state.histories,
          [state.activeDomain]: { ...history, currentIndex },
        },
        currentEntry: result,
      };
    });
    return result;
  },

  switchDomain: (activeDomain) =>
    set((state) => {
      const history = state.histories[activeDomain];
      return {
        activeDomain,
        currentEntry: history.entries[history.currentIndex] ?? null,
      };
    }),
});

export const useNavStore = create<NavSlice>()((set) => createNavSlice(set));
