fn main() {
    println!("cargo:rerun-if-changed=icons");
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=Speech");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }
    tauri_build::build()
}
