use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, CheckMenuItem, Submenu, IsMenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(target_os = "macos")]
mod speech_macos;

#[cfg(target_os = "linux")]
mod linux_frame_clock;

#[tauri::command]
fn native_frame_stats(window: tauri::Window) -> Option<serde_json::Value> {
    #[cfg(target_os = "linux")]
    return linux_frame_clock::stats(window.label()).and_then(|stats| serde_json::to_value(stats).ok());
    #[cfg(not(target_os = "linux"))]
    { let _ = window; None }
}

static MONITORING: AtomicBool = AtomicBool::new(false);
static PINNED: AtomicBool = AtomicBool::new(true);

const WINDOW_STATE_FLAGS: StateFlags = StateFlags::POSITION.union(StateFlags::SIZE);

fn save_window_state(app: &tauri::AppHandle) {
    // Save while native windows still exist. Teardown can bypass the plugin's
    // exit callback, and destroyed windows can no longer report their geometry.
    if let Err(error) = app.save_window_state(WINDOW_STATE_FLAGS) {
        eprintln!("[Cuttle Pets] Could not save window position: {error}");
    }
}

fn raise_settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Queue unminimize/show before focus: the Linux backend can otherwise
    // discard focus while its cached minimized/visible flags are still stale.
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let target = window.clone();
        window.run_on_main_thread(move || {
            if let Ok(native) = target.gtk_window() {
                // Present raises as well as focuses an existing GTK window.
                native.present_with_time(gtk::gdk::ffi::GDK_CURRENT_TIME as u32);
                if let Some(surface) = native.window() {
                    surface.raise();
                }
            }
        }).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    // Ordinary window: raise it on open so it doesn't land behind other
    // windows, but never pin it topmost.
    if let Some(window) = app.get_webview_window("settings") {
        return raise_settings_window(&window);
    }
    let window = tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("index.html?settings".into()))
        .title("Cuttle Pets — Settings")
        .inner_size(1280.0, 720.0)
        .min_inner_size(960.0, 540.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .center()
        .focused(true)
        .build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    linux_frame_clock::configure(&window);
    raise_settings_window(&window)
}

#[tauri::command]
fn set_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::Relaxed);
}

/// Show the main window, re-asserting always-on-top when pinned: some
/// window managers drop the topmost hint across hide/show cycles
/// (tray toggle, suspend resume).
fn show_main(window: &tauri::WebviewWindow) {
    let _ = window.show();
    if PINNED.load(Ordering::Relaxed) {
        let _ = window.set_always_on_top(true);
    }
}

#[derive(Clone, PartialEq, serde::Serialize)]
struct CursorPosition {
    x: i32,
    y: i32,
    window_x: i32,
    window_y: i32,
    window_w: u32,
    window_h: u32,
}

#[derive(serde::Deserialize)]
struct InputRegion {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[tauri::command]
fn supports_input_regions() -> bool {
    cfg!(target_os = "linux")
}

/// Keep the silhouette receptive even when Xwayland cannot track the cursor
/// over native Wayland windows or the desktop. None restores the full region.
#[tauri::command]
fn set_input_regions(window: tauri::Window, regions: Option<Vec<InputRegion>>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let target = window.clone();
        window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else { return };
            if gtk_window.window().is_some() {
                let region = regions.map(|rects| {
                    let region = gtk::cairo::Region::create();
                    for rect in rects {
                        if rect.width > 0 && rect.height > 0 {
                            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(rect.x, rect.y, rect.width, rect.height));
                        }
                    }
                    region
                });
                gtk_window.input_shape_combine_region(region.as_ref());
            }
        }).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (window, regions);
    Ok(())
}

#[tauri::command]
async fn pick_vrm_file() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("VRM Model", &["vrm"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_dance_file() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Motion", &["vmd", "vrma", "fbx"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_music_file() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Music", &["mp3", "wav", "ogg"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_companion_file() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("3D Model (GLB converts fastest)", &["glb", "gltf", "fbx", "dae"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn start_cursor_monitor(window: tauri::Window) -> Result<(), String> {
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let _ = &window;

    if MONITORING.load(Ordering::Relaxed) {
        return Ok(());
    }
    MONITORING.store(true, Ordering::Relaxed);

    // Linux/X11 runs on a dedicated OS thread: raw X pointers are not Send,
    // and Xlib calls must stay on one thread. XQueryPointer reports cursor
    // position in the same X-server pixels as the window geometry below
    // (both divided by scale_factor on emit, like the Windows path).
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            use std::os::raw::{c_int, c_uint};
            use std::time::Duration;

            let xlib = match x11_dl::xlib::Xlib::open() {
                Ok(lib) => lib,
                Err(_) => {
                    MONITORING.store(false, Ordering::Relaxed);
                    return;
                }
            };
            // SAFETY: display is used only on this thread, closed below.
            let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
            if display.is_null() {
                MONITORING.store(false, Ordering::Relaxed);
                return;
            }
            // Linux only needs this feed for eye tracking (silhouette input
            // regions own click-through), so a still cursor sends nothing.
            let mut last: Option<CursorPosition> = None;
            while MONITORING.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(32));
                let scale = window.scale_factor().unwrap_or(1.0);
                let pos = window.outer_position().unwrap_or_default();
                let size = window.outer_size().unwrap_or_default();
                let mut root_ret: x11_dl::xlib::Window = 0;
                let mut child_ret: x11_dl::xlib::Window = 0;
                let mut root_x: c_int = 0;
                let mut root_y: c_int = 0;
                let mut win_x: c_int = 0;
                let mut win_y: c_int = 0;
                let mut mask: c_uint = 0;
                let queried = unsafe {
                    let root = (xlib.XDefaultRootWindow)(display);
                    (xlib.XQueryPointer)(
                        display,
                        root,
                        &mut root_ret,
                        &mut child_ret,
                        &mut root_x,
                        &mut root_y,
                        &mut win_x,
                        &mut win_y,
                        &mut mask,
                    )
                };
                if queried == 0 {
                    continue;
                }

                let position = CursorPosition {
                    x: (root_x as f64 / scale) as i32,
                    y: (root_y as f64 / scale) as i32,
                    window_x: (pos.x as f64 / scale) as i32,
                    window_y: (pos.y as f64 / scale) as i32,
                    window_w: (size.width as f64 / scale) as u32,
                    window_h: (size.height as f64 / scale) as u32,
                };
                if last.as_ref() == Some(&position) {
                    continue;
                }
                let _ = window.emit("cursor-position", position.clone());
                last = Some(position);
            }
            unsafe {
                (xlib.XCloseDisplay)(display);
            }
        });
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    tauri::async_runtime::spawn(async move {
        use tokio::time::{sleep, Duration};

        while MONITORING.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(32)).await;

            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::{POINT, RECT};
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

                unsafe {
                    let mut cursor = POINT::default();
                    if GetCursorPos(&mut cursor).is_err() {
                        continue;
                    }

                    let hwnd = window.hwnd().unwrap();
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_err() {
                        continue;
                    }

                    // Convert physical pixels → logical (CSS) pixels to match
                    // elementFromPoint / hit-test expectations (same as macOS path).
                    let scale = window.scale_factor().unwrap_or(1.0);

                    let _ = window.emit(
                        "cursor-position",
                        CursorPosition {
                            x: (cursor.x as f64 / scale) as i32,
                            y: (cursor.y as f64 / scale) as i32,
                            window_x: (rect.left as f64 / scale) as i32,
                            window_y: (rect.top as f64 / scale) as i32,
                            window_w: ((rect.right - rect.left) as f64 / scale) as u32,
                            window_h: ((rect.bottom - rect.top) as f64 / scale) as u32,
                        },
                    );
                }
            }

            #[cfg(target_os = "macos")]
            {
                use core_graphics::event::CGEvent;
                use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

                let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
                    continue;
                };
                let Ok(event) = CGEvent::new(source) else {
                    continue;
                };
                // CGEvent location is in Quartz logical points (origin top-left)
                let loc = event.location();

                // Tauri outer_position() already returns top-left origin (tao flips
                // Cocoa's bottom-left Y internally), but in physical pixels.
                // Divide by scale_factor to get logical points matching CGEvent.
                let scale = window.scale_factor().unwrap_or(1.0);
                let pos = window.outer_position().unwrap_or_default();
                let size = window.outer_size().unwrap_or_default();

                let _ = window.emit(
                    "cursor-position",
                    CursorPosition {
                        x: loc.x as i32,
                        y: loc.y as i32,
                        window_x: (pos.x as f64 / scale) as i32,
                        window_y: (pos.y as f64 / scale) as i32,
                        window_w: (size.width as f64 / scale) as u32,
                        window_h: (size.height as f64 / scale) as u32,
                    },
                );
            }
        }
    });

    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[tauri::command]
async fn stop_cursor_monitor() -> Result<(), String> {
    MONITORING.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn start_speech_recognition(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        speech_macos::start(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Native speech recognition is only supported on macOS".into())
    }
}

#[tauri::command]
async fn stop_speech_recognition() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        speech_macos::stop()?;
    }
    Ok(())
}


#[derive(serde::Deserialize)]
struct TrayModel { name: String, url: String }

#[derive(serde::Deserialize)]
struct TrayAnimation { name: String, id: String }

/// Native tray submenus don't paginate: cap the entries and spill the rest
/// into the settings window (a scrollable breakout) via a tail item.
const TRAY_SUBMENU_PAGE_SIZE: usize = 25;

fn tray_menu(app: &tauri::AppHandle, models: &[TrayModel], selected: &str, music_enabled: bool, animations: &[TrayAnimation], quality: &str, text_enabled: bool, update_available: bool, current_version: &str, update_version: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let update_item = if update_available {
        Some(MenuItem::with_id(app, "update", &format!("● Update available: v{} → v{}", current_version, update_version), true, None::<&str>)?)
    } else {
        None
    };
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quality_labels = [("low", "Low"), ("mid", "Mid"), ("high", "High"), ("ultra", "Ultra")];
    let quality_items: Vec<CheckMenuItem<tauri::Wry>> = quality_labels.iter().map(|(id, label)|
        CheckMenuItem::with_id(app, format!("quality:{}", id), *label, true, *id == quality, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let quality_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = quality_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let quality_menu = Submenu::with_items(app, "Quality", true, &quality_refs)?;
    let paged_models = models.len() > TRAY_SUBMENU_PAGE_SIZE;
    let models_items: Vec<CheckMenuItem<tauri::Wry>> = models.iter().take(TRAY_SUBMENU_PAGE_SIZE).map(|model|
        CheckMenuItem::with_id(app, format!("model:{}", model.url), &model.name, true, model.url == selected, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = models_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let more_models;
    if paged_models {
        more_models = Some(MenuItem::with_id(app, "more-models", &format!("More models ({} more)…", models.len() - TRAY_SUBMENU_PAGE_SIZE), true, None::<&str>)?);
        refs.push(more_models.as_ref().unwrap() as &dyn IsMenuItem<tauri::Wry>);
    }
    let models_menu = Submenu::with_items(app, "Character model", true, &refs)?;
    let paged_animations = animations.len() > TRAY_SUBMENU_PAGE_SIZE;
    let animation_items: Vec<MenuItem<tauri::Wry>> = animations.iter().take(TRAY_SUBMENU_PAGE_SIZE).map(|animation|
        MenuItem::with_id(app, format!("animation:{}", animation.id), &animation.name, true, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let mut animation_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = animation_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let more_animations;
    if paged_animations {
        more_animations = Some(MenuItem::with_id(app, "more-animations", &format!("More animations ({} more)…", animations.len() - TRAY_SUBMENU_PAGE_SIZE), true, None::<&str>)?);
        animation_refs.push(more_animations.as_ref().unwrap() as &dyn IsMenuItem<tauri::Wry>);
    }
    let animation_menu = Submenu::with_items(app, "Animation", !animations.is_empty(), &animation_refs)?;
    let music = CheckMenuItem::with_id(app, "music", "React to music", true, music_enabled, None::<&str>)?;
    let text = CheckMenuItem::with_id(app, "text", "Show text bubbles", true, text_enabled, None::<&str>)?;
    let camera = MenuItem::with_id(app, "camera", "Reset camera", true, None::<&str>)?;
    let pose = MenuItem::with_id(app, "pose", "Stop animation", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    if let Some(update) = update_item.as_ref() {
        Menu::with_items(app, &[update, &show, &models_menu, &animation_menu, &quality_menu, &music, &text, &camera, &pose, &settings, &sep, &quit])
    } else {
        Menu::with_items(app, &[&show, &models_menu, &animation_menu, &quality_menu, &music, &text, &camera, &pose, &settings, &sep, &quit])
    }
}

const TRAY_ICON_NORMAL: &[u8] = include_bytes!("../icons/128x128.png");
const TRAY_ICON_UPDATE: &[u8] = include_bytes!("../icons/128x128-update.png");

/// Apply the update badge: blue-dot icon plus tooltip. Never touches user
/// data — this only changes the tray presentation.
fn apply_tray_update_state(app: &tauri::AppHandle, update_available: bool, current_version: &str, update_version: &str) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("cuttle-pet") {
        let icon_bytes = if update_available { TRAY_ICON_UPDATE } else { TRAY_ICON_NORMAL };
        let icon = tauri::image::Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        let tooltip = if update_available {
            format!("Cuttle Pets — update available: v{} → v{}", current_version, update_version)
        } else {
            "Cuttle Pets".to_string()
        };
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_tray_models(app: tauri::AppHandle, models: Vec<TrayModel>, selected: String, music_enabled: bool, animations: Vec<TrayAnimation>, quality: String, text_enabled: bool, update_available: bool, current_version: String, update_version: String) -> Result<(), String> {
    let menu = tray_menu(&app, &models, &selected, music_enabled, &animations, &quality, text_enabled, update_available, &current_version, &update_version).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("cuttle-pet") { tray.set_menu(Some(menu)).map_err(|e| e.to_string())?; }
    apply_tray_update_state(&app, update_available, &current_version, &update_version)
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = tray_menu(app.handle(), &[TrayModel { name: "Default character".into(), url: "/model1.vrm".into() }], "/model1.vrm", true, &[], "high", true, false, "", "")?;

    TrayIconBuilder::with_id("cuttle-pet")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?)
        .tooltip("Cuttle Pets")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_main(&window);
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .on_menu_event(move |app: &tauri::AppHandle, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match event.id().as_ref() {
                "show" => {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_main(&window);
                        let _ = window.set_focus();
                    }
                }
                "settings" | "more-models" | "more-animations" | "update" => { let _ = open_settings_window(app.clone()); }
                "quit" => {
                    save_window_state(app);
                    // Orderly shutdown: exiting with live WebViews makes
                    // WebKitWebProcess crash on Linux ("stopped
                    // unexpectedly"). Stop cursor polling, destroy the
                    // windows first so page unload handlers run and the
                    // renderers release their GL contexts, then exit.
                    MONITORING.store(false, Ordering::Relaxed);
                    for (_, window) in app.webview_windows() {
                        let _ = window.destroy();
                    }
                    app.exit(0);
                }
                id if id.starts_with("animation:") => {
                    show_main(&window);
                    let _ = window.emit("play-animation", &id[10..]);
                }
                id if id.starts_with("model:") => { let _ = window.emit("select-model", &id[6..]); }
                id => { let _ = window.emit("tray-control", id); }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NVIDIA's GBM rejects the hardware buffers WebKitGTK's DMA-BUF renderer
    // allocates ("Failed to create GBM buffer ... Invalid argument"), so its
    // default path renders nothing or crashes. Disabling the renderer avoids
    // that but drops WebKit to non-composited CPU painting (~25 fps on a large
    // pet window). Keep the renderer and use shared-memory buffers instead:
    // GPU compositing without GBM allocation; measured ~60 fps at lower CPU.
    // Set before GTK/WebKit starts; any explicit WebKit renderer variable wins.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/proc/driver/nvidia/version").exists()
        && ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_FORCE_DMABUF_RENDERER", "WEBKIT_DMABUF_RENDERER_FORCE_SHM"]
            .iter().all(|name| std::env::var_os(name).is_none())
    {
        std::env::set_var("WEBKIT_FORCE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
        eprintln!("[Cuttle Pets] NVIDIA detected: WebKit DMA-BUF renderer with shared-memory buffers");
    }
    // NVIDIA's GL driver busy-waits (sched_yield + clock polling) while the
    // web process waits on each WebGL frame, pinning a full core even for a
    // blank canvas. Sleeping instead cuts web-process CPU about 3x at the same
    // frame rate. Read by the driver at load time; an explicit value wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("__GL_YIELD").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var("__GL_YIELD", "USLEEP");
    }
    // Wayland does not let clients restore absolute window coordinates or keep
    // an always-on-top window pinned, so the pet loses its saved placement.
    // When an Xwayland display is present, prefer the X11 backend (the dev
    // launcher used to do this; the packaged app must do it itself). An
    // explicit GDK_BACKEND or CUTTLE_PET_BACKEND overrides the default.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none()
        && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland"
        && std::env::var_os("DISPLAY").is_some()
    {
        let backend = std::env::var("CUTTLE_PET_BACKEND").unwrap_or_else(|_| "x11".to_string());
        std::env::set_var("GDK_BACKEND", &backend);
        eprintln!("[Cuttle Pets] Wayland session with Xwayland: GDK_BACKEND={backend}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance is launched, show and focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                show_main(&window);
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(WINDOW_STATE_FLAGS)
            .build())
        .invoke_handler(tauri::generate_handler![
            open_settings_window,
            native_frame_stats,
            set_pinned,
            update_tray_models,
            pick_vrm_file,
            pick_dance_file,
            pick_music_file,
            pick_companion_file,
            supports_input_regions,
            set_input_regions,
            start_cursor_monitor,
            stop_cursor_monitor,
            start_speech_recognition,
            stop_speech_recognition,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                linux_frame_clock::configure(&window);
            }
            // macOS: activate as foreground app (needed when running as raw binary outside .app bundle)
            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::NSApplication;
                use objc2_app_kit::NSApplicationActivationPolicy;
                use objc2::MainThreadMarker;
                let mtm = MainThreadMarker::new().expect("must be on main thread");
                let ns_app = NSApplication::sharedApplication(mtm);
                ns_app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
                ns_app.activate();
            }

            #[cfg(target_os = "macos")]
            let window = app.get_webview_window("main").unwrap();

            setup_tray(app)?;

            // macOS application menu (top-left menu bar)
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};

                let app_menu = SubmenuBuilder::new(app, "Cuttle Pets")
                    .item(&MenuItem::with_id(app, "app_toggle", "Show / Hide", true, Some("CmdOrCtrl+Shift+H"))?)
                    .item(&MenuItem::with_id(app, "app_settings", "Settings", true, Some("CmdOrCtrl+,"))?)
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let menu = MenuBuilder::new(app).item(&app_menu).item(&edit_menu).build()?;
                app.set_menu(menu)?;

                let win = window.clone();
                app.on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "app_toggle" => {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                show_main(&win);
                                let _ = win.set_focus();
                            }
                        }
                        "app_settings" => { let _ = open_settings_window(app.clone()); }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                save_window_state(window.app_handle());
            }
            // Stop cursor polling once the main window is gone so the X11
            // thread doesn't emit to a destroyed window during teardown.
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                MONITORING.store(false, Ordering::Relaxed);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
