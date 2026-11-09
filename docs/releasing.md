# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please).
Merge its release PR and `.github/workflows/release-please.yml` does the rest:

1. **release-please** tags `vX.Y.Z` and publishes the GitHub release with the changelog.
2. **build** runs `tauri-apps/tauri-action` on four runners and uploads the installers to that release.
3. **checksums** downloads every asset on the release and uploads a `SHA256SUMS` file next to them.

Don't tag or create releases by hand — release-please owns both.

## What ships

| Platform | Runner | Installer |
|---|---|---|
| macOS arm64 | `macos-15` | `.dmg` (plus the `.app.tar.gz` tauri-action adds) |
| macOS x86_64 | `macos-15-intel` | `.dmg` (plus `.app.tar.gz`) |
| Linux x86_64 | `ubuntu-22.04` | `.deb`, `.AppImage` |
| Windows x86_64 | `windows-latest` | NSIS `-setup.exe` |

The targets are pinned in `src-tauri/tauri.conf.json` (`bundle.targets`). Each OS
builds the ones that apply to it and skips the rest.

**Why NSIS rather than MSI:** NSIS can install per-user without an admin prompt, and
it takes any semver — Tauri's MSI bundler only accepts numeric pre-release tags, so a
version like `0.3.0-rc.1` breaks it. MSI mostly earns its keep for Group Policy
deploys; it's easy to add back if someone asks.

Everything is **unsigned** for now. Expect Gatekeeper and SmartScreen warnings until
macOS Developer ID signing (#21) and Windows signing (#22) land.

## Test a release without shipping it

Run the workflow by hand from the Actions tab (**Release Please → Run workflow**,
pick a branch) or with `gh`. The release-please step is skipped on manual runs, so
nothing gets tagged, versioned or published.

Dry run — builds on all four OSes, keeps the installers and `SHA256SUMS` as workflow
artifacts, touches no releases:

```bash
gh workflow run release-please.yml --ref <branch>
```

Draft release — same build, but uploaded to a new draft pre-release called
`test-<run id>`. Drafts are only visible to people with write access and don't
create a git tag until published:

```bash
gh workflow run release-please.yml --ref <branch> -f draft-release=true
```

Download and poke at the installers, then delete the draft — **don't publish it**:

```bash
gh release delete test-<run id> --yes
```
