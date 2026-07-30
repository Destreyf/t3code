import { create } from "zustand";

export interface BrowserSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfacePresentation {
  readonly rect: BrowserSurfaceRect | null;
  readonly visible: boolean;
  readonly content: BrowserSurfaceContentPresentation | null;
  readonly fittedSourceContent: BrowserSurfaceContentPresentation | null;
  readonly fitSourceContent: boolean;
  readonly cornerRadius: number;
  readonly updatedAt: number;
  readonly owner: symbol | null;
}

export interface BrowserSurfaceContentPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

interface BrowserSurfaceStoreState {
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly captureCountByTabId: Record<string, number>;
  readonly claim: (tabId: string, owner: symbol, fitSourceContent: boolean) => void;
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius: number,
  ) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly release: (tabId: string, owner: symbol) => void;
  readonly beginCapture: (tabId: string) => void;
  readonly endCapture: (tabId: string) => void;
}

export interface BrowserSurfaceLease {
  readonly present: (rect: BrowserSurfaceRect, visible: boolean, cornerRadius?: number) => boolean;
  readonly release: () => void;
}

export interface BrowserCaptureSurfaceLease {
  readonly release: () => void;
}

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  return current?.rect ?? null;
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  byTabId: {},
  captureCountByTabId: {},
  claim: (tabId, owner, fitSourceContent) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner === owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            rect: current?.rect ?? null,
            visible: false,
            content: current?.content ?? null,
            fittedSourceContent: fitSourceContent ? (current?.content ?? null) : null,
            fitSourceContent,
            cornerRadius: current?.cornerRadius ?? 0,
            updatedAt: Date.now(),
            owner,
          },
        },
      };
    }),
  present: (tabId, owner, rect, visible, cornerRadius) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      if (
        current &&
        current.visible === visible &&
        current.cornerRadius === cornerRadius &&
        rectEquals(current.rect, rect)
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, rect, visible, cornerRadius, updatedAt: Date.now() },
        },
      };
    }),
  presentContent: (tabId, content) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current) {
        return {
          byTabId: {
            ...state.byTabId,
            [tabId]: {
              rect: null,
              visible: false,
              content,
              fittedSourceContent: null,
              fitSourceContent: false,
              cornerRadius: 0,
              updatedAt: Date.now(),
              owner: null,
            },
          },
        };
      }
      const previous = current.content;
      if (
        previous &&
        previous.x === content.x &&
        previous.y === content.y &&
        previous.width === content.width &&
        previous.height === content.height &&
        previous.scale === content.scale &&
        previous.scrollLeft === content.scrollLeft &&
        previous.scrollTop === content.scrollTop
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            content,
            fittedSourceContent:
              current.fitSourceContent && current.fittedSourceContent === null
                ? content
                : current.fittedSourceContent,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  release: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            visible: false,
            fittedSourceContent: null,
            fitSourceContent: false,
            updatedAt: Date.now(),
            owner: null,
          },
        },
      };
    }),
  beginCapture: (tabId) =>
    set((state) => ({
      captureCountByTabId: {
        ...state.captureCountByTabId,
        [tabId]: (state.captureCountByTabId[tabId] ?? 0) + 1,
      },
    })),
  endCapture: (tabId) =>
    set((state) => {
      const current = state.captureCountByTabId[tabId] ?? 0;
      if (current <= 1) {
        const { [tabId]: _released, ...captureCountByTabId } = state.captureCountByTabId;
        return { captureCountByTabId };
      }
      return {
        captureCountByTabId: {
          ...state.captureCountByTabId,
          [tabId]: current - 1,
        },
      };
    }),
}));

const waitForPresentationTick = (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, 50);
    window.requestAnimationFrame(finish);
  });

const waitForCaptureParking = async (tabId: string): Promise<void> => {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    const parked = Array.from(
      document.querySelectorAll<HTMLElement>("[data-preview-viewport]"),
    ).find(
      (candidate) =>
        candidate.getAttribute("data-preview-viewport") === tabId &&
        candidate.getAttribute("data-preview-composited") === "true",
    );
    if (parked) {
      await waitForPresentationTick();
      return;
    }
    await waitForPresentationTick();
  }
};

export function acquireBrowserCaptureSurface(tabId: string): BrowserCaptureSurfaceLease {
  let released = false;
  useBrowserSurfaceStore.getState().beginCapture(tabId);
  return {
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.getState().endCapture(tabId);
    },
  };
}

/**
 * Keep a hidden guest inside the compositor bounds only while a one-shot
 * capture needs it. Idle background tabs remain offscreen to avoid continuous
 * GPU work from animated pages.
 */
export async function withBrowserCaptureSurface<A>(
  tabId: string,
  capture: () => Promise<A>,
): Promise<A> {
  const lease = acquireBrowserCaptureSurface(tabId);
  try {
    await waitForCaptureParking(tabId);
    return await capture();
  } finally {
    lease.release();
  }
}

export function acquireBrowserSurface(
  tabId: string,
  fitSourceContent = false,
): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  let released = false;
  useBrowserSurfaceStore.getState().claim(tabId, owner, fitSourceContent);

  return {
    present: (rect, visible, cornerRadius = 0) => {
      if (released) return false;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner !== owner) return false;
      useBrowserSurfaceStore.getState().present(tabId, owner, rect, visible, cornerRadius);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.getState().release(tabId, owner);
    },
  };
}
