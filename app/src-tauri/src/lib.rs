use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, CheckMenuItem, Submenu, IsMenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

#[cfg(target_os = "macos")]
mod speech_macos;

static MONITORING: AtomicBool = AtomicBool::new(false);
static PINNED: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("index.html?settings".into()))
        .title("Cuttle Pets — Settings")
        .inner_size(1280.0, 720.0)
        .min_inner_size(960.0, 540.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .build().map_err(|e| e.to_string())?;
    Ok(())
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

#[derive(Clone, serde::Serialize)]
struct CursorPosition {
    x: i32,
    y: i32,
    window_x: i32,
    window_y: i32,
    window_w: u32,
    window_h: u32,
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
        .add_filter("VMD Motion", &["vmd"])
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

                let _ = window.emit(
                    "cursor-position",
                    CursorPosition {
                        x: (root_x as f64 / scale) as i32,
                        y: (root_y as f64 / scale) as i32,
                        window_x: (pos.x as f64 / scale) as i32,
                        window_y: (pos.y as f64 / scale) as i32,
                        window_w: (size.width as f64 / scale) as u32,
                        window_h: (size.height as f64 / scale) as u32,
                    },
                );
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

fn tray_menu(app: &tauri::AppHandle, models: &[TrayModel], selected: &str, music_enabled: bool, animations: &[TrayAnimation], quality: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quality_labels = [("low", "Low"), ("mid", "Mid"), ("high", "High"), ("ultra", "Ultra")];
    let quality_items: Vec<CheckMenuItem<tauri::Wry>> = quality_labels.iter().map(|(id, label)|
        CheckMenuItem::with_id(app, format!("quality:{}", id), *label, true, *id == quality, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let quality_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = quality_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let quality_menu = Submenu::with_items(app, "Quality", true, &quality_refs)?;
    let models_items: Vec<CheckMenuItem<tauri::Wry>> = models.iter().map(|model|
        CheckMenuItem::with_id(app, format!("model:{}", model.url), &model.name, true, model.url == selected, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = models_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let models_menu = Submenu::with_items(app, "Character model", true, &refs)?;
    let animation_items: Vec<MenuItem<tauri::Wry>> = animations.iter().map(|animation|
        MenuItem::with_id(app, format!("animation:{}", animation.id), &animation.name, true, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let animation_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = animation_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let animation_menu = Submenu::with_items(app, "Animation", !animations.is_empty(), &animation_refs)?;
    let music = CheckMenuItem::with_id(app, "music", "React to music", true, music_enabled, None::<&str>)?;
    let text = MenuItem::with_id(app, "text", "Toggle text bubbles", true, None::<&str>)?;
    let camera = MenuItem::with_id(app, "camera", "Reset camera", true, None::<&str>)?;
    let pose = MenuItem::with_id(app, "pose", "Stop animation", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &models_menu, &animation_menu, &quality_menu, &music, &text, &camera, &pose, &settings, &sep, &quit])
}

#[tauri::command]
fn update_tray_models(app: tauri::AppHandle, models: Vec<TrayModel>, selected: String, music_enabled: bool, animations: Vec<TrayAnimation>, quality: String) -> Result<(), String> {
    let menu = tray_menu(&app, &models, &selected, music_enabled, &animations, &quality).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("cuttle-pet") { tray.set_menu(Some(menu)).map_err(|e| e.to_string())?; }
    Ok(())
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = tray_menu(app.handle(), &[TrayModel { name: "Default character".into(), url: "/model1.vrm".into() }], "/model1.vrm", true, &[], "high")?;

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
                "settings" => { let _ = open_settings_window(app.clone()); }
                "quit" => {
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
            .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE)
            .build())
        .invoke_handler(tauri::generate_handler![
            open_settings_window,
            set_pinned,
            update_tray_models,
            pick_vrm_file,
            pick_dance_file,
            pick_music_file,
            start_cursor_monitor,
            stop_cursor_monitor,
            start_speech_recognition,
            stop_speech_recognition,
        ])
        .setup(|app| {
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

                let app_menu = SubmenuBuilder::new(app, "Claw Sama")
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
