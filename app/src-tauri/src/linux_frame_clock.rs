//! WebKitGTK asks libdrm for a display clock. NVIDIA deliberately has no DRM
//! vblank implementation on modern kernels, so WebKit falls back to 60 Hz.
//! Keep the real API on working drivers; replace only unsupported relative
//! sequence 0/1 queries with a monotonic timer at that CRTC's current mode rate.
//! This is a software display clock, not a hardware vsync signal. It lives only
//! in this executable (not LD_PRELOAD or a replacement system library).

use gtk::prelude::*;
use libloading::Library;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_int, c_uint, c_ulong, c_void, CStr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VBlankRequest {
    kind: c_uint,
    sequence: c_uint,
    signal: c_ulong,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VBlankReply {
    kind: c_uint,
    sequence: c_uint,
    sec: libc::c_long,
    usec: libc::c_long,
}
#[repr(C)]
pub union VBlank {
    request: VBlankRequest,
    reply: VBlankReply,
}
#[repr(C)]
struct Resources {
    count_fbs: c_int,
    fbs: *mut c_uint,
    count_crtcs: c_int,
    crtcs: *mut c_uint,
    count_connectors: c_int,
    connectors: *mut c_uint,
    count_encoders: c_int,
    encoders: *mut c_uint,
    min_width: c_uint,
    max_width: c_uint,
    min_height: c_uint,
    max_height: c_uint,
}
#[repr(C)]
#[derive(Default)]
struct Mode {
    clock: c_uint,
    hdisplay: u16,
    hsync_start: u16,
    hsync_end: u16,
    htotal: u16,
    hskew: u16,
    vdisplay: u16,
    vsync_start: u16,
    vsync_end: u16,
    vtotal: u16,
    vscan: u16,
    vrefresh: c_uint,
    flags: c_uint,
    kind: c_uint,
    name: [c_char; 32],
}
#[repr(C)]
struct Crtc {
    id: c_uint,
    buffer: c_uint,
    x: c_uint,
    y: c_uint,
    width: c_uint,
    height: c_uint,
    valid: c_int,
    mode: Mode,
    gamma_size: c_int,
}

struct Drm {
    _library: Library,
    wait: unsafe extern "C" fn(c_int, *mut VBlank) -> c_int,
    resources: unsafe extern "C" fn(c_int) -> *mut Resources,
    free_resources: unsafe extern "C" fn(*mut Resources),
    crtc: unsafe extern "C" fn(c_int, c_uint) -> *mut Crtc,
    free_crtc: unsafe extern "C" fn(*mut Crtc),
}
impl Drm {
    unsafe fn load() -> Option<Self> {
        let library = Library::new("libdrm.so.2").ok()?;
        Some(Self {
            wait: *library.get(b"drmWaitVBlank\0").ok()?,
            resources: *library.get(b"drmModeGetResources\0").ok()?,
            free_resources: *library.get(b"drmModeFreeResources\0").ok()?,
            crtc: *library.get(b"drmModeGetCrtc\0").ok()?,
            free_crtc: *library.get(b"drmModeFreeCrtc\0").ok()?,
            _library: library,
        })
    }
    unsafe fn refresh_rate(&self, fd: c_int, index: usize) -> Option<f64> {
        let resources = (self.resources)(fd);
        if resources.is_null() {
            return None;
        }
        let crtc = if (*resources).count_crtcs > index as c_int && !(*resources).crtcs.is_null() {
            (self.crtc)(fd, *(*resources).crtcs.add(index))
        } else {
            std::ptr::null_mut()
        };
        (self.free_resources)(resources);
        if crtc.is_null() {
            return None;
        }
        let hz = if (*crtc).valid != 0 {
            mode_hz(&(*crtc).mode)
        } else {
            None
        };
        (self.free_crtc)(crtc);
        hz
    }
}

fn mode_hz(mode: &Mode) -> Option<f64> {
    if mode.clock == 0 || mode.htotal == 0 || mode.vtotal == 0 {
        return None;
    }
    let mut hz = mode.clock as f64 * 1000.0 / mode.htotal as f64 / mode.vtotal as f64;
    if mode.flags & (1 << 4) != 0 {
        hz *= 2.0;
    } // interlace
    if mode.flags & (1 << 5) != 0 {
        hz /= 2.0;
    } // double scan
    if mode.vscan > 1 {
        hz /= mode.vscan as f64;
    }
    (hz.is_finite() && (10.0..=1000.0).contains(&hz)).then_some(hz)
}
fn relative_index(request: &VBlankRequest) -> Option<usize> {
    // Leave absolute waits, events, signals, multi-frame waits and every other
    // libdrm operation alone. These are the exact two queries WebKit uses.
    if request.kind & !(0x2000_003e | 1) != 0
        || request.kind & 1 == 0
        || request.sequence > 1
        || request.signal != 0
    {
        return None;
    }
    let high = (request.kind & 0x3e) >> 1;
    if high != 0 && request.kind & 0x2000_0000 != 0 {
        return None;
    }
    Some(if high != 0 {
        high as usize
    } else {
        usize::from(request.kind & 0x2000_0000 != 0)
    })
}

struct Clock {
    period: Duration,
    next: Instant,
    checked: Instant,
    sequence: u32,
}
impl Clock {
    fn advance(&mut self, now: Instant) -> Instant {
        // Recover after a pause without firing a burst of overdue frames.
        if self.next <= now {
            let missed = now.duration_since(self.next).as_secs_f64() / self.period.as_secs_f64();
            self.next += self.period.mul_f64(missed.floor() + 1.0);
        }
        let deadline = self.next;
        self.next += self.period;
        self.sequence = self.sequence.wrapping_add(1);
        deadline
    }
}
thread_local! { static CLOCKS: RefCell<HashMap<(c_int, usize), Clock>> = RefCell::new(HashMap::new()); }
static SOFTWARE_CLOCK: AtomicBool = AtomicBool::new(false);

/// Exported specifically by build.rs so libwebkit's public libdrm call resolves
/// here. dlsym on the libdrm handle resolves its original implementation.
/// All failures other than EOPNOTSUPP/ENOSYS pass through unchanged.
#[no_mangle]
pub unsafe extern "C" fn drmWaitVBlank(fd: c_int, vblank: *mut VBlank) -> c_int {
    static DRM: OnceLock<Option<Drm>> = OnceLock::new();
    static DISABLED: OnceLock<bool> = OnceLock::new();
    let Some(drm) = DRM.get_or_init(|| Drm::load()).as_ref() else {
        *libc::__errno_location() = libc::ENOSYS;
        return -1;
    };
    if vblank.is_null() {
        return (drm.wait)(fd, vblank);
    }
    let request = (*vblank).request;
    let result = (drm.wait)(fd, vblank);
    let error = *libc::__errno_location();
    if result == 0
        || ![libc::EOPNOTSUPP, libc::ENOSYS].contains(&error)
        || *DISABLED.get_or_init(|| std::env::var_os("CUTTLE_PET_DISABLE_MONITOR_CLOCK").is_some())
    {
        return result;
    }
    let Some(index) = relative_index(&request) else {
        return result;
    };
    let success = CLOCKS.with(|clocks| {
        let mut clocks = clocks.borrow_mut();
        let key = (fd, index);
        let now = Instant::now();
        // Re-query once a second and on construction to track mode changes and
        // descriptor reuse. An inactive/unknown output keeps WebKit's fallback.
        if request.sequence == 0 || clocks.get(&key).is_none_or(|clock| now.duration_since(clock.checked) >= Duration::from_secs(1)) {
            let Some(hz) = drm.refresh_rate(fd, index) else { clocks.remove(&key); return false; };
            let period = Duration::from_secs_f64(1.0 / hz);
            match clocks.get_mut(&key) {
                Some(clock) => { clock.period = period; clock.checked = now; }
                None => {
                    clocks.insert(key, Clock { period, next: now + period, checked: now, sequence: 0 });
                    SOFTWARE_CLOCK.store(true, Ordering::Relaxed);
                    eprintln!("[Cuttle Pets] DRM vblank unsupported; monitor software clock: CRTC {index}, {hz:.2} Hz");
                }
            }
        }
        let Some(clock) = clocks.get_mut(&key) else { return false; };
        if request.sequence == 1 {
            let deadline = clock.advance(Instant::now());
            if let Some(delay) = deadline.checked_duration_since(Instant::now()) { std::thread::sleep(delay); }
        }
        let mut wall: libc::timeval = std::mem::zeroed();
        libc::gettimeofday(&mut wall, std::ptr::null_mut());
        (*vblank).reply = VBlankReply { kind: request.kind, sequence: clock.sequence, sec: wall.tv_sec, usec: wall.tv_usec };
        true
    });
    *libc::__errno_location() = if success { 0 } else { error };
    if success {
        0
    } else {
        result
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStats {
    native_paint_fps: f64,
    native_max_paint_gap_ms: f64,
    display_hz: f64,
    clock_source: &'static str,
    native_width: i32,
    native_height: i32,
}
struct PaintStats {
    snapshot: NativeStats,
    start: Instant,
    last: Instant,
    frames: u32,
    max_gap: f64,
}
static PAINTS: OnceLock<Mutex<HashMap<String, PaintStats>>> = OnceLock::new();
pub fn stats(label: &str) -> Option<NativeStats> {
    let paints = PAINTS.get()?.lock().ok()?;
    let paint = paints.get(label)?;
    let mut stats = paint.snapshot.clone();
    if paint.last.elapsed() > Duration::from_secs(1) {
        stats.native_paint_fps = 0.0;
    }
    stats.clock_source = if SOFTWARE_CLOCK.load(Ordering::Relaxed) {
        "monitor-timer"
    } else {
        "webkit"
    };
    Some(stats)
}

pub fn configure(window: &tauri::WebviewWindow) {
    let label = window.label().to_owned();
    let _ = window.with_webview(move |view| {
        let webview = view.inner();
        // Feature API was introduced in WebKit 2.42; load dynamically to retain
        // compatibility with Tauri's older supported system WebKit versions.
        unsafe {
            allow_display_rate(webview.as_ptr().cast());
        }
        let unmap_label = label.clone();
        webview.connect_unmap(move |_| {
            if let Some(paints) = PAINTS.get() {
                if let Ok(mut paints) = paints.lock() {
                    paints.remove(&unmap_label);
                }
            }
        });
        if label == "settings" {
            // WebKit can queue allocation without invalidating the GTK surface.
            // During border dragging, explicitly schedule a coalesced paint for
            // each new allocation. Nothing runs when the window is unchanged.
            let previous = std::cell::Cell::new((0, 0));
            webview.connect_size_allocate(move |widget, allocation| {
                let size = (allocation.width(), allocation.height());
                if previous.replace(size) != size {
                    widget.queue_draw();
                }
            });
        }
        webview.connect_draw(move |widget, _| {
            let now = Instant::now();
            let display_hz = widget
                .window()
                .and_then(|surface| surface.display().monitor_at_window(&surface))
                .map(|monitor| monitor.refresh_rate() as f64 / 1000.0)
                .unwrap_or(0.0);
            let allocation = widget.allocation();
            if let Ok(mut paints) = PAINTS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
                if !paints.contains_key(&label) {
                    paints.insert(
                        label.clone(),
                        PaintStats {
                            snapshot: NativeStats {
                                native_paint_fps: 0.0,
                                native_max_paint_gap_ms: 0.0,
                                display_hz,
                                clock_source: "webkit",
                                native_width: allocation.width(),
                                native_height: allocation.height(),
                            },
                            start: now,
                            last: now,
                            frames: 0,
                            max_gap: 0.0,
                        },
                    );
                }
                let Some(paint) = paints.get_mut(&label) else {
                    return gtk::glib::Propagation::Proceed;
                };
                let gap = now.duration_since(paint.last);
                if label == "settings" && gap > Duration::from_secs(1) {
                    // An idle settings window has no paints. Its first repaint
                    // starts a fresh measurement, not a multi-minute "stall".
                    paint.start = now;
                    paint.frames = 0;
                    paint.max_gap = 0.0;
                } else {
                    paint.max_gap = paint.max_gap.max(gap.as_secs_f64() * 1000.0);
                }
                paint.last = now;
                paint.frames += 1;
                paint.snapshot.display_hz = display_hz;
                paint.snapshot.native_width = allocation.width();
                paint.snapshot.native_height = allocation.height();
                let elapsed = now.duration_since(paint.start).as_secs_f64();
                if elapsed >= 1.0 {
                    paint.snapshot.native_paint_fps =
                        (paint.frames as f64 / elapsed * 10.0).round() / 10.0;
                    paint.snapshot.native_max_paint_gap_ms = (paint.max_gap * 10.0).round() / 10.0;
                    paint.frames = 0;
                    paint.max_gap = 0.0;
                    paint.start = now;
                }
            }
            gtk::glib::Propagation::Proceed
        });
    });
}

unsafe fn allow_display_rate(webview: *mut c_void) {
    unsafe fn apply(webview: *mut c_void) -> Option<()> {
        let library = Library::new("libwebkit2gtk-4.1.so.0").ok()?;
        let settings = library
            .get::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(
                b"webkit_web_view_get_settings\0",
            )
            .ok()?;
        let features = library
            .get::<unsafe extern "C" fn() -> *mut c_void>(b"webkit_settings_get_all_features\0")
            .ok()?;
        let length = library
            .get::<unsafe extern "C" fn(*mut c_void) -> c_uint>(b"webkit_feature_list_get_length\0")
            .ok()?;
        let get = library
            .get::<unsafe extern "C" fn(*mut c_void, c_uint) -> *mut c_void>(
                b"webkit_feature_list_get\0",
            )
            .ok()?;
        let identifier = library
            .get::<unsafe extern "C" fn(*mut c_void) -> *const c_char>(
                b"webkit_feature_get_identifier\0",
            )
            .ok()?;
        let enable = library
            .get::<unsafe extern "C" fn(*mut c_void, *mut c_void, c_int)>(
                b"webkit_settings_set_feature_enabled\0",
            )
            .ok()?;
        let unref = library
            .get::<unsafe extern "C" fn(*mut c_void)>(b"webkit_feature_list_unref\0")
            .ok()?;
        let settings = settings(webview);
        let list = features();
        if settings.is_null() || list.is_null() {
            return None;
        }
        for i in 0..length(list) {
            let feature = get(list, i);
            if feature.is_null() {
                continue;
            }
            let id = identifier(feature);
            if !id.is_null()
                && CStr::from_ptr(id).to_bytes() == b"PreferPageRenderingUpdatesNear60FPS"
            {
                enable(settings, feature, 0);
                eprintln!("[Cuttle Pets] WebKit rendering updates follow the display rate");
                break;
            }
        }
        unref(list);
        Some(())
    }
    let _ = apply(webview);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_webkit_relative_waits_are_adapted() {
        let mut request = VBlankRequest {
            kind: 1,
            sequence: 1,
            signal: 0,
        };
        assert_eq!(relative_index(&request), Some(0));
        request.kind |= 0x2000_0000;
        assert_eq!(relative_index(&request), Some(1));
        request.kind = 1 | (3 << 1);
        assert_eq!(relative_index(&request), Some(3));
        request.kind |= 0x400_0000;
        assert_eq!(relative_index(&request), None);
        request.kind = 0;
        assert_eq!(relative_index(&request), None);
        request.kind = 1;
        request.sequence = 2;
        assert_eq!(relative_index(&request), None);
        request.sequence = 1;
        request.signal = 1;
        assert_eq!(relative_index(&request), None);
    }
    #[test]
    fn fractional_mode_rates_and_scan_flags() {
        let mut mode = Mode {
            clock: 148_352,
            htotal: 2200,
            vtotal: 1125,
            ..Mode::default()
        };
        assert!((mode_hz(&mode).unwrap() - 59.94).abs() < 0.001);
        mode.flags = 1 << 4;
        assert!((mode_hz(&mode).unwrap() - 119.88).abs() < 0.001);
        mode.flags |= 1 << 5;
        mode.vscan = 2;
        assert!((mode_hz(&mode).unwrap() - 29.97).abs() < 0.001);
        mode.htotal = 0;
        assert_eq!(mode_hz(&mode), None);
    }
    #[test]
    fn deadlines_keep_phase_and_skip_missed_frames() {
        let now = Instant::now();
        let period = Duration::from_secs_f64(1.0 / 120.0);
        let mut clock = Clock {
            period,
            next: now + period,
            checked: now,
            sequence: 0,
        };
        assert_eq!(clock.advance(now), now + period);
        assert_eq!(
            clock.advance(now + period + Duration::from_millis(1)),
            now + period * 2
        );
        let resumed = now + Duration::from_secs(2);
        let deadline = clock.advance(resumed);
        assert!(deadline > resumed && deadline <= resumed + period);
    }
    #[test]
    fn drm_mode_abi() {
        assert_eq!(std::mem::size_of::<Mode>(), 68);
        assert_eq!(std::mem::offset_of!(Crtc, mode), 28);
        assert_eq!(std::mem::size_of::<Crtc>(), 100);
        assert_eq!(std::mem::offset_of!(VBlankReply, sec), 8);
        let (request, reply, resources) = if cfg!(target_pointer_width = "64") {
            (16, 24, 80)
        } else {
            (12, 16, 48)
        };
        assert_eq!(std::mem::size_of::<VBlankRequest>(), request);
        assert_eq!(std::mem::size_of::<VBlankReply>(), reply);
        assert_eq!(std::mem::size_of::<VBlank>(), reply);
        assert_eq!(std::mem::size_of::<Resources>(), resources);
    }
}
