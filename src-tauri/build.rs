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

/// The minipro sidecar (`bundle.externalBin`) and its databases
/// (`bundle.resources`) are build outputs, not checked in. tauri-build refuses
/// to build without them; say how to make them instead of its generic error.
fn require_sidecar() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let exe = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar = format!("binaries/burnwright-minipro-{target}{exe}");
    println!("cargo:rerun-if-changed={sidecar}");
    println!("cargo:rerun-if-changed=binaries/minipro");
    let missing: Vec<&str> = [sidecar.as_str(), "binaries/minipro/infoic.xml"]
        .into_iter()
        .filter(|p| !std::path::Path::new(p).exists())
        .collect();
    if !missing.is_empty() {
        panic!(
            "\n\nmissing minipro sidecar: {}\n\
             Build it once with `pnpm sidecar` (macOS/Linux, or an MSYS2 UCRT64 shell\n\
             on Windows), and again after bumping vendor/minipro.\n\
             See docs/minipro-sidecar.md.\n",
            missing.join(", ")
        );
    }
}

fn main() {
    require_sidecar();
    println!("cargo:rerun-if-changed=../vendor/minipro/Makefile");
    println!(
        "cargo:rustc-env=BURNWRIGHT_MINIPRO_VERSION={}",
        minipro_version()
    );
    tauri_build::build()
}
