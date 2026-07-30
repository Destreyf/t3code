import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserCaptureSurface,
  acquireBrowserSurface,
  resolveBrowserSurfacePanelRect,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";
import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ byTabId: {}, captureCountByTabId: {} });
  });

  it("keeps capture parking active until every concurrent lease releases", () => {
    const first = acquireBrowserCaptureSurface("capture-tab");
    const second = acquireBrowserCaptureSurface("capture-tab");

    expect(useBrowserSurfaceStore.getState().captureCountByTabId["capture-tab"]).toBe(2);
    first.release();
    first.release();
    expect(useBrowserSurfaceStore.getState().captureCountByTabId["capture-tab"]).toBe(1);
    second.release();
    expect(useBrowserSurfaceStore.getState().captureCountByTabId["capture-tab"]).toBeUndefined();
  });

  it("parks only the agent-pinned background tab while another browser tab stays visible", () => {
    const visibleTab = acquireBrowserSurface("visible-tab");
    const pinnedTab = acquireBrowserSurface("agent-pinned-tab");
    const visibleRect = { x: 120, y: 80, width: 900, height: 640 };
    const pinnedRect = { x: 40, y: 60, width: 800, height: 500 };
    visibleTab.present(visibleRect, true);
    pinnedTab.present(pinnedRect, false);

    const capture = acquireBrowserCaptureSurface("agent-pinned-tab");
    const capturing = useBrowserSurfaceStore.getState();

    expect(capturing.byTabId["visible-tab"]).toMatchObject({
      rect: visibleRect,
      visible: true,
    });
    expect(capturing.byTabId["agent-pinned-tab"]).toMatchObject({
      rect: pinnedRect,
      visible: false,
    });
    expect(capturing.captureCountByTabId).toEqual({ "agent-pinned-tab": 1 });
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        captureActive: false,
        rect: visibleRect,
        hiddenSize: { width: 900, height: 640 },
      }),
    ).toMatchObject({ left: 120, top: 80, zIndex: 30, pointerEvents: "auto" });
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        captureActive: true,
        rect: pinnedRect,
        hiddenSize: { width: 800, height: 500 },
      }),
    ).toMatchObject({ left: 0, top: 0, zIndex: -1, pointerEvents: "none" });

    capture.release();

    const released = useBrowserSurfaceStore.getState();
    expect(released.captureCountByTabId).toEqual({});
    expect(released.byTabId["visible-tab"]?.visible).toBe(true);
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        captureActive: false,
        rect: pinnedRect,
        hiddenSize: { width: 800, height: 500 },
      }),
    ).toMatchObject({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      zIndex: -1,
    });

    pinnedTab.release();
    visibleTab.release();
  });

  it("freezes the source content dimensions for a fitted presentation", () => {
    const tabId = "fitted-browser-surface";
    const sourceOwner = Symbol("source");
    const sourceContent = {
      x: 10,
      y: 20,
      width: 1_280,
      height: 720,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    };
    useBrowserSurfaceStore.getState().claim(tabId, sourceOwner, false);
    useBrowserSurfaceStore.getState().presentContent(tabId, sourceContent);

    const fittedLease = acquireBrowserSurface(tabId, true);
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      ...sourceContent,
      width: 360,
      height: 203,
      scale: 0.28125,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.fittedSourceContent).toEqual(
      sourceContent,
    );
    fittedLease.release();
  });

  it("freezes the first content dimensions when fitting starts before the browser is measured", () => {
    const tabId = "pending-fitted-browser-surface";
    const fittedLease = acquireBrowserSurface(tabId, true);
    const sourceContent = {
      x: 0,
      y: 0,
      width: 1_280,
      height: 720,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    };

    useBrowserSurfaceStore.getState().presentContent(tabId, sourceContent);
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      ...sourceContent,
      width: 320,
      height: 180,
      scale: 0.25,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.fittedSourceContent).toEqual(
      sourceContent,
    );
    fittedLease.release();
  });

  it("tracks content dimensions for a browser that has never been visible", () => {
    const tabId = "hidden-browser-surface-content-test";
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: 0,
      y: 0,
      width: 393,
      height: 852,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: null,
      visible: false,
      content: { width: 393, height: 852 },
    });
  });

  it("keeps a hidden background tab on its own last rect", () => {
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    expect(
      resolveBrowserSurfacePanelRect(
        {
          hidden: {
            rect: staleRect,
            visible: false,
            content: null,
            fittedSourceContent: null,
            fitSourceContent: false,
            cornerRadius: 0,
            updatedAt: 1,
            owner: null,
          },
          active: {
            rect: liveRect,
            visible: true,
            content: null,
            fittedSourceContent: null,
            fitSourceContent: false,
            cornerRadius: 0,
            updatedAt: 2,
            owner: null,
          },
        },
        "hidden",
      ),
    ).toEqual(staleRect);
  });

  it("ignores updates and releases from a stale surface lease", () => {
    const tabId = "leased-browser-surface";
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    const staleLease = acquireBrowserSurface(tabId);
    staleLease.present(staleRect, true);

    const liveLease = acquireBrowserSurface(tabId);
    liveLease.present(liveRect, true);
    expect(staleLease.present(staleRect, true)).toBe(false);
    staleLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
    });
  });

  it("hides a surface when its current lease is released", () => {
    const tabId = "released-browser-surface";
    const lease = acquireBrowserSurface(tabId);
    lease.present({ x: 10, y: 20, width: 900, height: 640 }, true);

    lease.release();
    lease.present({ x: 0, y: 0, width: 1, height: 1 }, true);

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      visible: false,
      owner: null,
    });
  });

  it("clears fitted presentation state when its lease is released", () => {
    const tabId = "released-fitted-browser-surface";
    const fittedLease = acquireBrowserSurface(tabId, true);
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: 0,
      y: 0,
      width: 1_280,
      height: 800,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    fittedLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      fittedSourceContent: null,
      fitSourceContent: false,
      owner: null,
      visible: false,
    });
  });
});
