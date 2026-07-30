# Electron background preview capture

Status checked: 2026-07-30

## Conclusion

The reported T3 Code behavior already has an exact T3 issue, two overlapping open T3 pull requests, and a nearly identical historical Electron issue.

Electron does not currently have an open pull request that can be cherry-picked. Its current capture implementation still requires a valid compositor surface before capture begins, so T3 must make the specific inactive guest compositable before calling `capturePage()`. A deadline around each capture remains necessary because Electron has repeatedly had hidden-surface captures hang or fail.

## T3 Code matches

| Item                                                                                                                                  | Status                                                   | Relevance                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Issue #3713: `preview_snapshot` can fail or time out and leave automation unusable](https://github.com/pingdotgg/t3code/issues/3713) | Open; no linked closing PR                               | Exact symptom report: initial capture error, retry timeout, subsequent evaluation timeout, and `UnknownVizError` in another run.                                                                                        |
| [PR #4685: Make preview automation fail with the real cause, not a timeout](https://github.com/pingdotgg/t3code/pull/4685)            | Open, unmerged; CI green; automated approval only        | Closest small PR. It retries `capturePage()` three times at 120 ms intervals and shortens host waits so typed failures beat the broker deadline.                                                                        |
| [PR #4577: Harden preview automation reliability](https://github.com/pingdotgg/t3code/pull/4577)                                      | Open, unmerged; merge state `BLOCKED`; no human approval | Closest complete PR. It stages inactive targets for background capture, bounds capture and session work, prefers CDP screenshots with a `capturePage()` fallback, and permits semantic snapshots without raster output. |
| [PR #3565: Stabilize preview browser surfaces, automation, and recording](https://github.com/pingdotgg/t3code/pull/3565)              | Merged 2026-06-27                                        | Introduced the retained, physically offscreen guest model. Its description explicitly says inactive Electron webviews remain CSS-visible but physically offscreen.                                                      |
| [PR #4397: Add background preview capture and picture-in-picture support](https://github.com/pingdotgg/t3code/pull/4397)              | Merged 2026-07-27                                        | Added repeated `capturePage()` frame capture for recording/PiP, but did not make the one-shot automation snapshot path present an offscreen guest first.                                                                |

The checked-in baseline makes the causal chain explicit:

1. Inactive guests are moved to `left/top: -100000px` while remaining CSS-visible ([source at the current base commit](https://github.com/pingdotgg/t3code/blob/abc409c2d4a072c2de46c9015f5cffff00dcc46b/apps/web/src/browser/hostedBrowserWebviewStyle.ts#L19-L50)).
2. The snapshot host calls desktop automation without first changing that presentation ([source](https://github.com/pingdotgg/t3code/blob/abc409c2d4a072c2de46c9015f5cffff00dcc46b/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L578-L581)).
3. The desktop snapshot runs `wc.capturePage()` while holding the tab's control session ([source](https://github.com/pingdotgg/t3code/blob/abc409c2d4a072c2de46c9015f5cffff00dcc46b/apps/desktop/src/preview/Manager.ts#L2671-L2713)).

### How the open PRs compare with the local fix

[PR #4685](https://github.com/pingdotgg/t3code/pull/4685) is narrow—166 additions and 8 deletions across five files—but retries only after a capture rejects. It does not stage the guest in-window or bound an individual never-settling `capturePage()`, so it cannot by itself solve the persistent `-100000px` hang or release the control session promptly.

[PR #4577](https://github.com/pingdotgg/t3code/pull/4577) covers both compositor staging and poisoned-session recovery, but is broad—2,999 additions and 204 deletions across 35 files—and also changes snapshot nullability, debugger capture, runtime identity, pairing, and development configuration.

The current local implementation overlaps #4685's retry and host-budget work, adds a one-second deadline to each attempt, and overlaps #4577's presentation-lease idea with a smaller in-window `z-index: -1` parking mechanism. A new PR would therefore duplicate active work unless maintainers choose to update/supersede #4685 or extract the relevant subset from #4577.

## Electron evidence

### Exact offscreen `<webview>` reproduction

[Electron issue #37611](https://github.com/electron/electron/issues/37611) is the closest upstream match. Its test places two `<webview>` elements in a horizontally scrollable container:

- On Electron 22, capturing the scrolled-out webview remains pending until the user scrolls it into view.
- On Electron 23, the same request returns a 0×0 image unless the webview is first brought into view.
- The reporter describes the condition as a web contents being "offscreen somehow (scrolled out of sight)" and needing to be "brought into view to be screenshottable."

That issue was closed as `not planned` on 2023-11-20 after inactivity. No fix PR was attached, and its old Electron versions are a limitation, but its geometry and recovery trigger closely match T3's `-100000px` placement and thread/tab-switch behavior.

### Hidden-surface capture remains fallible

[Electron issue #36376](https://github.com/electron/electron/issues/36376) remains open. The original Electron 22 reproduction could leave a hidden-window capture unsettled. Retesting on Electron 28/29 changed the outcome to rejection with `Current display surface not available for capture`, confirming that lack of a display surface remains an explicit capture failure.

Earlier reports show the same family of failure:

- [Issue #30666](https://github.com/electron/electron/issues/30666) reported zero-size images and hanging capture for hidden `BrowserView` content. [PR #32973](https://github.com/electron/electron/pull/32973) merged a historical capturer-count regression fix in 2022.
- [Issue #27891](https://github.com/electron/electron/issues/27891) reported that capture on a hidden window could freeze the browser process. [PR #27883](https://github.com/electron/electron/pull/27883) instead made hidden capture settle with an empty image on affected platforms.
- [PR #39730](https://github.com/electron/electron/pull/39730) later fixed fully occluded `BrowserWindow` capture on Windows/Linux by dispatching completion to the UI thread. It does not cover an embedded `<webview>` placed outside its viewport.
- [PR #41281](https://github.com/electron/electron/pull/41281) was closed unmerged after its `CopyFromSurface` scaling path produced sporadic `UnknownVizError` failures in Electron CI. The trigger differs, but it confirms that the error comes from the same upstream surface-copy operation.

### Why `stayHidden` is not sufficient

Electron 41.5.0 is the version used by this T3 checkout. Its official [`capturePage` documentation](https://github.com/electron/electron/blob/v41.5.0/docs/api/web-contents.md#L1720-L1736) says capturer count can treat a page as visible when its browser window is hidden, and exposes `stayHidden` to avoid showing that window. This contract addresses browser-window visibility, not CSS clipping or geometric placement of an embedded `<webview>`.

The Electron 41.5.0 implementation:

1. obtains the render-widget view;
2. rejects if `IsSurfaceAvailableForCopy()` is false;
3. only then increments capturer count; and
4. calls `CopyFromSurface()` ([source](https://github.com/electron/electron/blob/v41.5.0/shell/browser/api/electron_api_web_contents.cc#L3707-L3758)).

Its completion path maps Chromium's surface-copy errors directly, including `kUnknownVizError` ([source](https://github.com/electron/electron/blob/v41.5.0/shell/browser/api/electron_api_web_contents.cc#L586-L632)). Chromium itself documents that `CopyFromSurface` may return stale data or fail when a view is suspended or occluded ([interface](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/browser/render_widget_host_view.h#220)).

Because Electron checks surface availability before increasing capturer count, capture options cannot revive a guest that has already lost its compositing surface. T3's presentation lease must occur before capture starts.

## Recommended direction

- Keep the local pre-capture presentation lease; it directly addresses the exact Electron #37611 condition.
- Keep a bounded per-attempt capture deadline; retries alone do not help a promise that never settles.
- Coordinate with T3 PRs #4685 and #4577 before opening another PR. #4685 is the natural small integration point, while #4577 already owns the broader session-lifecycle and nullable-snapshot design.
- Do not wait on an Electron upgrade as the fix. Electron 41.5.0 still exposes the surface-availability constraint, and no open Electron PR targets offscreen embedded-webview capture.
