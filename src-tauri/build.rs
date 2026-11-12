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

/// `<version>+<short commit>` for the T76 build, e.g. `0.7.4+3e2f491`. Upstream
/// hasn't bumped `VERSION` since the 0.7.4 release, so the version alone
/// can't tell the two builds apart. Both come from the `NOTICE.txt` the
/// sidecar build writes next to the T76 databases, which records what was
/// actually built. "unknown" if that file doesn't say.
fn minipro_t76_version() -> String {
    let notice = fs::read_to_string("binaries/minipro-t76/NOTICE.txt").unwrap_or_default();
    let version = notice
        .lines()
        .find_map(|line| line.strip_prefix("minipro "))
        .and_then(|rest| rest.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let commit = notice
        .lines()
        .find_map(|line| line.trim().strip_prefix("Commit:"))
        .and_then(|rest| rest.split_whitespace().next())
        .filter(|c| c.len() >= 7 && c.chars().all(|c| c.is_ascii_hexdigit()));
    match (version, commit) {
        (Some(version), Some(commit)) => format!("{version}+{}", &commit[..7]),
        _ => "unknown".to_string(),
    }
}

/// The minipro sidecars (`bundle.externalBin`) and their databases
/// (`bundle.resources`) are build outputs, not checked in. tauri-build refuses
/// to build without them; say how to make them instead of its generic error.
/// There are two: the stable build and the T76-only one (see
/// `scripts/minipro/versions.sh`).
fn require_sidecar() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let exe = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let mut wanted = Vec::new();
    for (name, res) in [
        ("burnwright-minipro", "minipro"),
        ("burnwright-minipro-t76", "minipro-t76"),
    ] {
        let sidecar = format!("binaries/{name}-{target}{exe}");
        println!("cargo:rerun-if-changed={sidecar}");
        println!("cargo:rerun-if-changed=binaries/{res}");
        wanted.push(sidecar);
        wanted.push(format!("binaries/{res}/infoic.xml"));
    }
    let missing: Vec<&str> = wanted
        .iter()
        .map(String::as_str)
        .filter(|p| !std::path::Path::new(p).exists())
        .collect();
    if !missing.is_empty() {
        panic!(
            "\n\nmissing minipro sidecar: {}\n\
             Build it once with `pnpm sidecar` (macOS/Linux, or an MSYS2 UCRT64 shell\n\
             on Windows), and again after bumping vendor/minipro or vendor/minipro-t76.\n\
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
    println!("cargo:rerun-if-changed=binaries/minipro-t76/NOTICE.txt");
    println!(
        "cargo:rustc-env=BURNWRIGHT_MINIPRO_T76_VERSION={}",
        minipro_t76_version()
    );
    tauri_build::build()
}
