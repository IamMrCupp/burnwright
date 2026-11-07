use std::fs;

/// Reads `VERSION = x.y.z` from the vendored minipro Makefile so the app can
/// report which minipro it was built against. Falls back to "unknown" when the
/// submodule isn't checked out, so a missing submodule never breaks the build.
fn minipro_version() -> String {
    fs::read_to_string("../vendor/minipro/Makefile")
        .ok()
        .and_then(|makefile| {
            makefile.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key.trim() == "VERSION").then(|| value.trim().to_string())
            })
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=../vendor/minipro/Makefile");
    println!(
        "cargo:rustc-env=BURNWRIGHT_MINIPRO_VERSION={}",
        minipro_version()
    );
    tauri_build::build()
}
