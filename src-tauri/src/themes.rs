//! The themes folder: `themes` in burnwright's config directory, one JSON
//! file per theme.
//!
//! This side only finds the files and hands their text over. What a theme
//! may contain is decided in one place, the frontend (`src/lib/theme.ts`),
//! which checks every name and value before anything reaches the page.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// The largest theme file that's read. A real one is a few hundred bytes.
const MAX_THEME_BYTES: u64 = 64 * 1024;

/// The most files listed from one folder.
const MAX_THEMES: usize = 200;

/// One file from the themes folder: its text, or why there isn't any.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ThemeFile {
    /// The file's name in the folder, `amber.json`.
    pub file: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// The themes folder as it was found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ThemeListing {
    /// The folder's full path, to show and to open.
    pub folder: String,
    pub files: Vec<ThemeFile>,
}

/// The `.json` files in `dir`, by name, making the folder if it isn't there
/// yet so there's somewhere to put the first theme.
///
/// A file that can't be read, is too big or isn't UTF-8 is still listed,
/// with the reason: the person who put it there should hear about it.
/// Hidden files and anything that isn't a regular file are left out.
pub fn list(dir: &Path) -> io::Result<ThemeListing> {
    fs::create_dir_all(dir)?;
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && name.to_ascii_lowercase().ends_with(".json"))
        .collect();
    names.sort();
    names.truncate(MAX_THEMES);

    let files = names
        .into_iter()
        .filter_map(|file| match read(&dir.join(&file)) {
            Ok(Some(text)) => Some(ThemeFile {
                file,
                text: Some(text),
                error: None,
            }),
            Ok(None) => None,
            Err(reason) => Some(ThemeFile {
                file,
                text: None,
                error: Some(reason),
            }),
        })
        .collect();
    Ok(ThemeListing {
        folder: dir.to_string_lossy().into_owned(),
        files,
    })
}

/// One file's text. `Ok(None)` for something that isn't a regular file (a
/// folder that happens to be called `x.json`).
fn read(path: &Path) -> Result<Option<String>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("it couldn't be read ({e})"))?;
    if !meta.is_file() {
        return Ok(None);
    }
    let too_big = || format!("it's bigger than {} KiB", MAX_THEME_BYTES / 1024);
    if meta.len() > MAX_THEME_BYTES {
        return Err(too_big());
    }
    // The size is checked again while reading: the file can grow in between.
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_THEME_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("it couldn't be read ({e})"))?;
    if bytes.len() as u64 > MAX_THEME_BYTES {
        return Err(too_big());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "it isn't UTF-8 text".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A folder of its own under the system's temp directory, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "burnwright-themes-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            Scratch(dir)
        }

        fn themes(&self) -> PathBuf {
            self.0.join("config").join("themes")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn makes_the_folder_and_finds_nothing_in_it() {
        let scratch = Scratch::new();
        let listing = list(&scratch.themes()).unwrap();
        assert!(scratch.themes().is_dir());
        assert_eq!(listing.folder, scratch.themes().to_string_lossy());
        assert!(listing.files.is_empty());
    }

    #[test]
    fn lists_json_files_by_name_with_their_text() {
        let scratch = Scratch::new();
        let dir = scratch.themes();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("zebra.json"), r#"{"base":"light"}"#).unwrap();
        fs::write(dir.join("Amber.JSON"), r#"{"base":"dark"}"#).unwrap();
        fs::write(dir.join("notes.txt"), "not a theme").unwrap();
        fs::write(dir.join(".hidden.json"), "{}").unwrap();
        fs::create_dir(dir.join("folder.json")).unwrap();

        let listing = list(&dir).unwrap();
        let names: Vec<&str> = listing.files.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(names, ["Amber.JSON", "zebra.json"]);
        assert_eq!(listing.files[0].text.as_deref(), Some(r#"{"base":"dark"}"#));
        assert_eq!(listing.files[0].error, None);
    }

    #[test]
    fn lists_a_file_it_wont_read_with_the_reason() {
        let scratch = Scratch::new();
        let dir = scratch.themes();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("big.json"),
            vec![b' '; MAX_THEME_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(dir.join("binary.json"), [0xff, 0xfe, 0x00]).unwrap();
        fs::write(dir.join("edge.json"), vec![b' '; MAX_THEME_BYTES as usize]).unwrap();

        let listing = list(&dir).unwrap();
        assert_eq!(
            listing.files[0],
            ThemeFile {
                file: "big.json".into(),
                text: None,
                error: Some("it's bigger than 64 KiB".into()),
            }
        );
        assert_eq!(
            listing.files[1].error.as_deref(),
            Some("it isn't UTF-8 text")
        );
        // Exactly the limit is still read.
        assert!(listing.files[2].text.is_some());
    }
}
