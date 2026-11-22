//! View → Appearance in the macOS menu bar: a second way to the Appearance
//! choice in the window's footer, for when the footer has scrolled away.
//!
//! The webview owns the choice and the list of themes
//! (`AppearanceController` in src/lib/appearance.ts). It sends both here
//! whenever either changes ([`set_appearance_menu`]), and this side redraws
//! the submenu to match. A click goes back the other way as an
//! [`EVENT`], and the webview does what the footer's controls would have
//! done. Nothing about the look is decided here.
//!
//! What goes in the submenu ([`plan`]) and what a click means
//! ([`action_for`]) are plain functions, tested on every platform. Only
//! putting the items in the menu bar is macOS-only: the app has no menu bar
//! anywhere else.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// The event a click in the submenu sends to the webview. Its payload is a
/// [`MenuAction`].
pub const EVENT: &str = "appearance-menu";

/// The id of the Appearance submenu itself.
#[cfg(target_os = "macos")]
const SUBMENU_ID: &str = "appearance";

const CHOICE_PREFIX: &str = "appearance:";
const OPEN_FOLDER_ID: &str = "appearance-open-folder";
const RELOAD_ID: &str = "appearance-reload";
const SAVE_ID: &str = "appearance-save";

/// One theme as the webview lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MenuTheme {
    /// The file's name in the themes folder: what the choice is made by.
    pub id: String,
    /// What the Appearance list calls it.
    pub name: String,
}

/// What the Appearance choice in the window is showing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct AppearanceMenuState {
    /// `system`, `light`, `dark`, or `theme:` and a file name.
    pub choice: String,
    pub themes: Vec<MenuTheme>,
    /// Whether there's a themes folder to open, reload and save into.
    pub has_folder: bool,
}

impl Default for AppearanceMenuState {
    /// What the menu shows until the webview has said anything.
    fn default() -> Self {
        Self {
            choice: "system".into(),
            themes: Vec::new(),
            has_folder: false,
        }
    }
}

/// What a click in the submenu asks the webview to do.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum MenuAction {
    /// Make this the Appearance choice.
    Choose {
        choice: String,
    },
    OpenFolder,
    Reload,
    Save,
}

/// The action behind a menu item's id, or `None` for an item that isn't one
/// of this submenu's.
pub fn action_for(id: &str) -> Option<MenuAction> {
    match id {
        OPEN_FOLDER_ID => Some(MenuAction::OpenFolder),
        RELOAD_ID => Some(MenuAction::Reload),
        SAVE_ID => Some(MenuAction::Save),
        _ => id
            .strip_prefix(CHOICE_PREFIX)
            .filter(|choice| !choice.is_empty())
            .map(|choice| MenuAction::Choose {
                choice: choice.to_string(),
            }),
    }
}

/// One line of the submenu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A choice, with a check mark when it's the current one.
    Choice {
        id: String,
        text: String,
        checked: bool,
    },
    /// Something to do.
    Command {
        id: &'static str,
        text: &'static str,
    },
    Separator,
}

/// A name as menu text. The menu takes `&` as the mark for a keyboard
/// mnemonic, so a real one is doubled.
fn menu_text(name: &str) -> String {
    name.replace('&', "&&")
}

/// The submenu for `state`, top to bottom: the three built-in looks, the
/// themes if there are any, then the folder's commands if there's a folder.
pub fn plan(state: &AppearanceMenuState) -> Vec<Entry> {
    let choice = |value: &str, text: String| Entry::Choice {
        id: format!("{CHOICE_PREFIX}{value}"),
        text,
        checked: state.choice == value,
    };
    let mut entries = vec![
        choice("system", "System".into()),
        choice("light", "Light".into()),
        choice("dark", "Dark".into()),
    ];
    if !state.themes.is_empty() {
        entries.push(Entry::Separator);
        for theme in &state.themes {
            entries.push(choice(
                &format!("theme:{}", theme.id),
                menu_text(&theme.name),
            ));
        }
    }
    if state.has_folder {
        entries.push(Entry::Separator);
        entries.push(Entry::Command {
            id: OPEN_FOLDER_ID,
            text: "Open Themes Folder",
        });
        entries.push(Entry::Command {
            id: RELOAD_ID,
            text: "Reload Themes",
        });
        entries.push(Entry::Command {
            id: SAVE_ID,
            text: "Save Look as Theme",
        });
    }
    entries
}

/// Put `entries` in `submenu`, in place of whatever it held.
#[cfg(target_os = "macos")]
fn fill<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    submenu: &tauri::menu::Submenu<R>,
    entries: &[Entry],
) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem};

    while submenu.remove_at(0)?.is_some() {}
    for entry in entries {
        match entry {
            Entry::Choice { id, text, checked } => submenu.append(&CheckMenuItem::with_id(
                app,
                id.as_str(),
                text,
                true,
                *checked,
                None::<&str>,
            )?)?,
            Entry::Command { id, text } => {
                submenu.append(&MenuItem::with_id(app, *id, text, true, None::<&str>)?)?
            }
            Entry::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

/// The Appearance submenu, wherever it is under the menu bar.
#[cfg(target_os = "macos")]
fn find<R: tauri::Runtime>(
    menu: &tauri::menu::Menu<R>,
) -> tauri::Result<Option<tauri::menu::Submenu<R>>> {
    use tauri::menu::MenuItemKind;

    for top in menu.items()? {
        let MenuItemKind::Submenu(top) = top else {
            continue;
        };
        for item in top.items()? {
            if let MenuItemKind::Submenu(submenu) = item
                && submenu.id().as_ref() == SUBMENU_ID
            {
                return Ok(Some(submenu));
            }
        }
    }
    Ok(None)
}

/// Add View → Appearance to `menu`, showing the built-in looks until the
/// webview sends what it has. The View menu is Tauri's own; if a later
/// Tauri stops making one, the submenu gets a View menu of its own.
#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    menu: &tauri::menu::Menu<R>,
) -> tauri::Result<()> {
    use tauri::menu::{MenuItemKind, PredefinedMenuItem, Submenu};

    let appearance = Submenu::with_id(app, SUBMENU_ID, "Appearance", true)?;
    fill(app, &appearance, &plan(&AppearanceMenuState::default()))?;

    let view = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("View") => {
            Some(submenu)
        }
        _ => None,
    });
    match view {
        Some(view) => {
            view.append(&PredefinedMenuItem::separator(app)?)?;
            view.append(&appearance)?;
        }
        None => menu.append(&Submenu::with_items(app, "View", true, &[&appearance])?)?,
    }
    Ok(())
}

/// Redraw View → Appearance to show `state`: the webview calls this at
/// startup and whenever its choice or its list of themes changes, and after
/// every click in the submenu (a click flips the item's own check mark,
/// whatever came of it). Does nothing where there's no menu bar.
#[tauri::command]
pub fn set_appearance_menu<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: AppearanceMenuState,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let Some(menu) = app.menu() else {
            return Ok(());
        };
        if let Some(submenu) = find(&menu).map_err(|e| e.to_string())? {
            fill(&app, &submenu, &plan(&state)).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(choice: &str, themes: &[(&str, &str)], has_folder: bool) -> AppearanceMenuState {
        AppearanceMenuState {
            choice: choice.into(),
            themes: themes
                .iter()
                .map(|(id, name)| MenuTheme {
                    id: (*id).into(),
                    name: (*name).into(),
                })
                .collect(),
            has_folder,
        }
    }

    fn texts(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Choice { text, checked, .. } => {
                    format!("{}{text}", if *checked { "✓ " } else { "" })
                }
                Entry::Command { text, .. } => (*text).to_string(),
                Entry::Separator => "—".to_string(),
            })
            .collect()
    }

    #[test]
    fn starts_as_the_three_looks_with_system_checked() {
        assert_eq!(
            texts(&plan(&AppearanceMenuState::default())),
            ["✓ System", "Light", "Dark"]
        );
    }

    #[test]
    fn lists_themes_and_the_folders_commands_and_checks_the_choice() {
        let entries = plan(&state(
            "theme:amber.json",
            &[("amber.json", "Amber terminal"), ("paper.json", "Paper")],
            true,
        ));
        assert_eq!(
            texts(&entries),
            [
                "System",
                "Light",
                "Dark",
                "—",
                "✓ Amber terminal",
                "Paper",
                "—",
                "Open Themes Folder",
                "Reload Themes",
                "Save Look as Theme",
            ]
        );
    }

    #[test]
    fn has_no_folder_commands_where_theres_no_folder() {
        assert_eq!(
            texts(&plan(&state("dark", &[], false))),
            ["System", "Light", "✓ Dark"]
        );
        // A folder with nothing in it: the commands, and no empty group.
        assert_eq!(
            texts(&plan(&state("light", &[], true))),
            [
                "System",
                "✓ Light",
                "Dark",
                "—",
                "Open Themes Folder",
                "Reload Themes",
                "Save Look as Theme",
            ]
        );
    }

    #[test]
    fn checks_nothing_when_the_choice_isnt_in_the_list() {
        let entries = plan(&state("theme:gone.json", &[("amber.json", "Amber")], true));
        assert!(
            entries
                .iter()
                .all(|entry| !matches!(entry, Entry::Choice { checked: true, .. }))
        );
    }

    #[test]
    fn shows_an_ampersand_in_a_themes_name_as_itself() {
        let entries = plan(&state("system", &[("b.json", "Black & amber")], false));
        assert!(texts(&entries).contains(&"Black && amber".to_string()));
    }

    #[test]
    fn every_item_it_plans_turns_back_into_its_action() {
        let entries = plan(&state(
            "system",
            &[("amber.json", "Amber"), ("my theme: 2.json", "Odd")],
            true,
        ));
        let actions: Vec<MenuAction> = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Choice { id, .. } => action_for(id),
                Entry::Command { id, .. } => action_for(id),
                Entry::Separator => None,
            })
            .collect();
        let choose = |choice: &str| MenuAction::Choose {
            choice: choice.into(),
        };
        assert_eq!(
            actions,
            [
                choose("system"),
                choose("light"),
                choose("dark"),
                choose("theme:amber.json"),
                choose("theme:my theme: 2.json"),
                MenuAction::OpenFolder,
                MenuAction::Reload,
                MenuAction::Save,
            ]
        );
    }

    #[test]
    fn leaves_other_menu_items_alone() {
        for id in ["burnwright-quit", "appearance", "appearance:", "", "quit"] {
            assert_eq!(action_for(id), None, "{id:?}");
        }
    }

    #[test]
    fn an_action_reaches_the_webview_in_the_shape_it_reads() {
        assert_eq!(
            serde_json::to_value(MenuAction::Choose {
                choice: "theme:amber.json".into()
            })
            .unwrap(),
            serde_json::json!({ "action": "choose", "choice": "theme:amber.json" })
        );
        assert_eq!(
            serde_json::to_value(MenuAction::OpenFolder).unwrap(),
            serde_json::json!({ "action": "open_folder" })
        );
        assert_eq!(
            serde_json::to_value(MenuAction::Reload).unwrap(),
            serde_json::json!({ "action": "reload" })
        );
        assert_eq!(
            serde_json::to_value(MenuAction::Save).unwrap(),
            serde_json::json!({ "action": "save" })
        );
    }

    #[test]
    fn reads_the_state_the_webview_sends() {
        let sent = serde_json::json!({
            "choice": "theme:amber.json",
            "themes": [{ "id": "amber.json", "name": "Amber" }],
            "has_folder": true,
        });
        assert_eq!(
            serde_json::from_value::<AppearanceMenuState>(sent).unwrap(),
            state("theme:amber.json", &[("amber.json", "Amber")], true)
        );
    }

    /// `invoke("set_appearance_menu", …)` as src/lib/device/tauri.ts makes
    /// it, through Tauri's own argument handling on its mock runtime: a
    /// renamed argument or field fails here, not in front of a user. The
    /// mock app has no menu bar, so there's nothing to redraw.
    #[test]
    fn the_frontends_call_is_accepted() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context};
        use tauri::webview::InvokeRequest;

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![set_appearance_menu])
            .build(mock_context(tauri::test::noop_assets()))
            .expect("the mock app builds");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("the mock window builds");
        let invoke = |body: serde_json::Value| {
            get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: "set_appearance_menu".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };

        let sent = serde_json::json!({
            "state": {
                "choice": "theme:amber.json",
                "themes": [{ "id": "amber.json", "name": "Amber" }],
                "has_folder": true,
            }
        });
        assert_eq!(invoke(sent), Ok(serde_json::Value::Null));
        // A body the frontend wouldn't send is refused, not half-read.
        assert!(invoke(serde_json::json!({ "state": { "choice": "dark" } })).is_err());
    }
}
