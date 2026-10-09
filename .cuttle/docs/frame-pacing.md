# Frame pacing diagnostics

Use `python3 cli/cuttle_pet.py stats` to inspect the existing pet. Do not open
another pet instance just to measure it.

| Field | Meaning |
| --- | --- |
| `fps` | Rendered scene frames after the application cap |
| `browserFps` | Browser animation callbacks before the cap |
| `maxFps`, `idleFps` | User-selected upper limits |
| `effectiveMaxFps`, `settingsResizing` | Current render budget and temporary settings-resize state |
| `frameMs`, `maxFrameMs` | Mean/maximum synchronous render-loop work |
| `maxBrowserGapMs` | Largest callback gap in the latest measurement window |
| `longBrowserGaps` | Cumulative callback gaps over 100 ms in this scene, excluding explicit suspension |
| `displayHz` | Refresh rate of the window's current GTK monitor |
| `clockSource` | `monitor-timer` after the native compatibility clock has been used; otherwise `webkit` |
| `nativePaintFps` | GTK paint callbacks for this window; zero after it stops painting |
| `nativeMaxPaintGapMs` | Largest native paint gap in the latest active window |
| `nativeWidth`, `nativeHeight` | Allocated webview size in logical pixels |
| `width`, `height`, `pixelRatio` | WebGL drawing-buffer dimensions and pixel ratio |

These counters distinguish browser scheduling, application frame limiting, and
native window painting. They do **not** measure GPU execution time or physical
scanout. A short JS callback does not establish that the GPU is idle. Native and
browser counters use independent one-second measurement windows.

## Confirmed Linux 60 FPS cause

On the tested NVIDIA 595.91.07 / WebKitGTK 2.52.6 / GTK 3.24.52 installation,
GTK correctly reported primary HDMI-1 at 119.98 Hz and secondary DP-1 at 59.98 Hz.
Both active CRTCs and their physical connector dimensions were discoverable and
the primary DRM node was readable. However, `drmWaitVBlank` returned `-1` with
`errno = EOPNOTSUPP (95)` for both monitors, even with the desktop unlocked.
Capture errno directly: the upstream log formats `-ret`, so libdrm returning
`-1` can misleadingly appear as a permissions error.
The installed NVIDIA source skips `drm_vblank_init` when the kernel supports
`drm_crtc_state.no_vblank`; this is missing driver functionality, not a wrong FPS
setting or permission to open the device.

WebKit's DRM monitor constructor rejects that result. Its fallback clock always
uses 60 Hz and sleeps for `1000 / 60` integer milliseconds (16 ms), explaining the
previous ~62.1–62.2 callback rate. WebKit also defaults its
`PreferPageRenderingUpdatesNear60FPS` feature on. Raising the app's FPS cap alone
cannot change either dependency behavior. The current upstream timer still has
this fixed rate, so an unverified dependency upgrade is not the fix.

The executable now supplies an isolated compatibility implementation of the
**public libdrm ABI**. It calls the original function first. Only unsupported
relative sequence-0/1 queries without event/signal flags are adapted; working
vblank implementations and all other errors/requests pass through unchanged.
The fallback reads the selected CRTC's active mode, retains fractional refresh
rates, and sleeps to monotonic deadlines without drift or catch-up bursts.
WebKit retains ownership of the clock thread, including stop/hide/suspend.
No system libraries or desktop/GPU settings are replaced.

This is a monitor-paced **software clock**, not hardware vsync. It removes the
fixed 60 Hz fallback while leaving final presentation to GTK/the compositor.
`CUTTLE_PET_DISABLE_MONITOR_CLOCK=1` opts out for comparison. The WebKit feature
API is loaded dynamically to disable the near-60 preference on versions that
provide it; older system libraries can still load the app. The fallback export
must be present in the final executable (`nm -D ... | rg drmWaitVBlank`).

Primary sources:

- [WebKitGTK 2.52.6 DRM monitor creation](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/UIProcess/glib/DisplayVBlankMonitorDRM.cpp)
- [WebKitGTK monitor selection](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/UIProcess/glib/DisplayVBlankMonitor.cpp)
- [WebKitGTK fixed timer](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/UIProcess/glib/DisplayVBlankMonitorTimer.cpp)
- [Current upstream timer](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/glib/DisplayVBlankMonitorTimer.cpp)
- [WebKit feature API](https://webkitgtk.org/reference/webkit2gtk/stable/method.Settings.set_feature_enabled.html)
- [NVIDIA DRM initialization](https://github.com/NVIDIA/open-gpu-kernel-modules/blob/595.91.07/kernel-open/nvidia-drm/nvidia-drm-drv.c)
- [NVIDIA GL scheduling controls](https://download.nvidia.com/XFree86/Linux-x86_64/595.91.07/README/openglenvvariables.html)

## Remaining frame cost and resizing

The large 1344×2080 working scene (character, laptop, cup and companion) painted
above 60 FPS after the clock fix. Sampling the real web process found 4864 of
7066 sampled stacks inside the native WebGL `clear` call. That locates most of the
sampled frame cost in the native graphics path; it does not distinguish GPU work
from driver synchronization. Low pixel
ratio, disabling MSAA, and disabling NVIDIA GL swap sync did not establish a
useful improvement. Disabling GTK frame synchronization actually restored a
60 FPS native painting ceiling; those experiments were removed.

Initial model/texture loading, shader compilation and the initial persona PNG
capture can cause a startup dip. Compare `longBrowserGaps` before/after a steady
run, instead of treating the first sample after reload as steady-state FPS.
Steady measurements also observed occasional callback gaps over 100 ms while
completed scene frames took at most about 10–12 ms. Those gaps happen outside the
measured scene work; the counters expose them but do not identify their exact
driver/compositor/system scheduling cause. The tested large Ultra scene typically
rendered about 80–96 FPS. Removing the fixed timer ceiling does not guarantee a
constant 120 FPS under that workload.

Settings schedules a GTK paint on each **changed native allocation**. GTK
coalesces these requests; there is no continuous repaint timer or resize debounce.
Each settings resize event also reserves graphics headroom: the pet uses at most
30 FPS for 250 ms after the most recent event, then returns to the user's limit.
The budget never raises a lower limit and never changes persisted preferences.
Expiry is checked by the existing pet loop; no extra running timer is needed.

A native comparison on the primary monitor found that the full-rate pet workload
could skip resize events (113 of 120 delivered) with active paint gaps up to
310 ms. With the pet at 30 FPS, all 120 changes arrived and active paint gaps
stayed below 40 ms. This motivated the temporary budget, rather than an always-on
settings repaint loop. The implemented automatic budget also delivered all 120
changes in native tests
on both monitors, with typical active paint gaps around 35–50 ms after settling.
The main window reported `effectiveMaxFps: 30` during resizing and recovered to
`120`, with `settingsResizing: false`, afterward. Browser tests verify
resize-message routing separately.
These tests check actual native resize delivery and painting; they do not by
themselves establish physical mouse delivery or the subjective feel of border
dragging.
