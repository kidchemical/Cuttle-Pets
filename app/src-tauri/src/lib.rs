use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, CheckMenuItem, Submenu, IsMenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

#[cfg(target_os = "macos")]
mod speech_macos;

static MONITORING: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", target_os = "macos"))]
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
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = &window;

    if MONITORING.load(Ordering::Relaxed) {
        return Ok(());
    }
    MONITORING.store(true, Ordering::Relaxed);

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

fn tray_menu(app: &tauri::AppHandle, models: &[TrayModel], selected: &str, music_enabled: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let models_items: Vec<CheckMenuItem<tauri::Wry>> = models.iter().map(|model|
        CheckMenuItem::with_id(app, format!("model:{}", model.url), &model.name, true, model.url == selected, None::<&str>)
    ).collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = models_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let models_menu = Submenu::with_items(app, "Character model", true, &refs)?;
    let music = CheckMenuItem::with_id(app, "music", "React to music", true, music_enabled, None::<&str>)?;
    let text = MenuItem::with_id(app, "text", "Toggle text bubbles", true, None::<&str>)?;
    let camera = MenuItem::with_id(app, "camera", "Reset camera", true, None::<&str>)?;
    let pose = MenuItem::with_id(app, "pose", "Stop animation", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &models_menu, &music, &text, &camera, &pose, &settings, &sep, &quit])
}

#[tauri::command]
fn update_tray_models(app: tauri::AppHandle, models: Vec<TrayModel>, selected: String, music_enabled: bool) -> Result<(), String> {
    let menu = tray_menu(&app, &models, &selected, music_enabled).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("cuttle-pet") { tray.set_menu(Some(menu)).map_err(|e| e.to_string())?; }
    Ok(())
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = tray_menu(app.handle(), &[TrayModel { name: "Default character".into(), url: "/model1.vrm".into() }], "/model1.vrm", true)?;

    TrayIconBuilder::with_id("cuttle-pet")
        .icon(app.default_window_icon().unwrap().clone())
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
                        let _ = window.show();
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
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "settings" => {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("open-settings", ());
                }
                "quit" => {
                    app.exit(0);
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
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE)
            .build())
        .invoke_handler(tauri::generate_handler![
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
                app.on_menu_event(move |_app, event| {
                    match event.id().as_ref() {
                        "app_toggle" => {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "app_settings" => {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.emit("open-settings", ());
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
