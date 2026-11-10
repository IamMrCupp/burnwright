# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please).
Merge its release PR and `.github/workflows/release-please.yml` does the rest:

1. **release-please** tags `vX.Y.Z` and publishes the GitHub release with the changelog.
2. **build** builds the minipro sidecar, runs `tauri-apps/tauri-action` on four runners, uploads the installers to that release, and checks the sidecar inside each one ([minipro-sidecar.md](minipro-sidecar.md)). On the two macOS runners it also signs and notarizes, if the Apple secrets are set ([below](#macos-signing-and-notarization)).
3. **sources** uploads `minipro-sidecar-source_<version>.tar.gz`, the corresponding source for the bundled minipro.
4. **checksums** downloads every asset on the release and uploads a `SHA256SUMS` file next to them.

Don't tag or create releases by hand — release-please owns both.

## What ships

| Platform | Runner | Installer |
|---|---|---|
| macOS arm64 | `macos-15` | `.dmg` |
| macOS x86_64 | `macos-15-intel` | `.dmg` |
| Linux x86_64 | `ubuntu-22.04` | `.deb`, `.AppImage` |
| Windows x86_64 | `windows-latest` | NSIS `-setup.exe` |

The targets are pinned in `src-tauri/tauri.conf.json` (`bundle.targets`). Each OS
builds the ones that apply to it and skips the rest.

**Why NSIS rather than MSI:** NSIS can install per-user without an admin prompt, and
it takes any semver — Tauri's MSI bundler only accepts numeric pre-release tags, so a
version like `0.3.0-rc.1` breaks it. MSI mostly earns its keep for Group Policy
deploys; it's easy to add back if someone asks.

**Signing:** the macOS `.dmg`s are signed with a Developer ID and notarized when the
repo has the five Apple secrets, and unsigned when it has none — see
[macOS signing and notarization](#macos-signing-and-notarization). The Linux and
Windows installers are unsigned; expect a SmartScreen warning until Windows signing
(#22) lands.

## Test a release without shipping it

Run the workflow by hand from the Actions tab (**Release Please → Run workflow**,
pick a branch) or with `gh`. The release-please step is skipped on manual runs, so
nothing gets tagged, versioned or published.

Dry run — builds on all four OSes, keeps the installers, the sidecar source archive
and `SHA256SUMS` as workflow artifacts, touches no releases:

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

A manual run signs and notarizes the macOS builds exactly like a real release does,
if the secrets are set. That makes the dry run the place to prove a new certificate
or API key works — before a release depends on it.

## macOS signing and notarization

Gatekeeper only opens a downloaded app without a fight when it's signed with a
Developer ID certificate **and** notarized by Apple. The workflow does both, on one
condition: the repo has all five secrets below.

| Secrets set | What the macOS jobs do |
|---|---|
| None | Build unsigned, same as before. Forks land here. |
| All five | Sign, notarize, staple, verify, then upload. |
| Some | Fail, naming the missing ones. A half-configured repo doesn't get to ship unsigned by accident. |

The job summary says which one happened. PR builds (`ci.yml`) never see the secrets
and stay unsigned.

### What gets signed

A signed build goes inside out — Apple rejects a bundle whose nested code isn't
signed first:

1. `scripts/macos/signing.sh setup` imports the certificate into a temporary keychain and writes the API key to a file, both under `$RUNNER_TEMP`.
2. Tauri's bundler signs `Contents/MacOS/burnwright-minipro` (the sidecar), then the app binary, then `burnwright.app` — hardened runtime on, secure timestamp from Apple. It notarizes the `.app`, staples the ticket to it, builds the `.dmg` around it and signs that.
3. `scripts/macos/notarize-dmg.sh` notarizes and staples the `.dmg`. Tauri stops at signing it, and an unstapled disk image can't prove itself on a Mac that's offline.
4. `scripts/macos/signing.sh cleanup` deletes the keychain and the key file — before the verification steps, and even when an earlier step failed.
5. `scripts/macos/verify-signing.sh` runs the checks under [Check a release](#check-a-release-is-signed-and-notarized) and fails the job if any of them do.
6. Only then is the `.dmg` uploaded to the release. A build that fails notarization never reaches users.

**No entitlements file.** The hardened runtime gates things like JIT, unsigned
executable memory and loading other people's libraries. burnwright needs none of
them: the webview's JIT lives in Apple's own WebKit process, and the sidecar links
only libraries macOS ships (libusb is static). USB isn't on the list at all —
`com.apple.security.device.usb` is an App Sandbox entitlement, and burnwright isn't
sandboxed. Checked the practical way: an ad-hoc build with the hardened runtime on
and no entitlements found a T48 over USB.

### One-time setup

You need the **Account Holder** role on the Apple Developer account — only that
role can create Developer ID certificates. Work in a scratch folder outside the repo
and delete it when you're done.

**1. Create the certificate.** It has to be **Developer ID Application**. Not
*Developer ID Installer* (that signs `.pkg` files), and not *Apple Development* or
*Apple Distribution* (those are for the App Store and can't satisfy Gatekeeper).

- Easiest: Xcode → Settings → Accounts → pick the team → Manage Certificates → **+** → Developer ID Application. The certificate and its private key land in your login keychain.
- Without Xcode: Keychain Access → Certificate Assistant → *Request a Certificate From a Certificate Authority* → save the request to disk. Then [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/add) → Developer ID Application → upload the request → download the `.cer` and double-click it.

Apple caps how many Developer ID certificates an account can hold, and they last
five years. One is enough — CI is the only thing that signs releases.

**2. Export it as a `.p12`.** Keychain Access → login keychain → *My Certificates*.
Expand `Developer ID Application: <name> (<team id>)` and check the private key is
listed under it — a certificate without its key can't sign. Right-click the
certificate → Export → format *Personal Information Exchange (.p12)* → save it as
`developer-id.p12`. Keychain Access asks for an export password: generate a long
one in your password manager. It becomes the `APPLE_CERTIFICATE_PASSWORD` secret.

**3. Create the App Store Connect API key.** [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api)
→ Users and Access → Integrations → App Store Connect API → **Team Keys** →
Generate API Key. Name it for what it does (`burnwright notarization`) and give it
the **Developer** role, which is enough to notarize. Then collect three things:

- the `AuthKey_<key id>.p8` file — Apple lets you download it exactly once
- the **Key ID** (ten characters, also in that file's name)
- the **Issuer ID** (a UUID shown above the list of keys)

If the page offers *Request Access* instead, the Account Holder has to accept the
API terms first.

**Why an API key and not an Apple ID.** Notarization also accepts an Apple ID with
an app-specific password. That password hangs off your personal Apple ID: change
the Apple ID's password and every app-specific password dies with it, usually
discovered by a release failing. The API key is a team credential with its own
role, it's revoked on its own without touching anything else, and it needs neither
your Apple ID nor the team ID stored in CI. The workflow only wires up the API key.

**4. Add the five secrets.** Run these from a checkout of the repo. Each one reads
the value from a file, a pipe or `gh`'s own prompt — never from `--body`, which
would leave it in your shell history.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | `developer-id.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | the export password from step 2 |
| `APPLE_API_KEY` | the Key ID |
| `APPLE_API_ISSUER` | the Issuer ID |
| `APPLE_API_KEY_P8` | the contents of `AuthKey_<key id>.p8` |

```bash
base64 -i developer-id.p12 | gh secret set APPLE_CERTIFICATE
```

```bash
gh secret set APPLE_API_KEY_P8 < AuthKey_<key id>.p8
```

The other three are short strings. With no input, `gh` prompts for a paste and
doesn't echo it:

```bash
gh secret set APPLE_CERTIFICATE_PASSWORD
```

```bash
gh secret set APPLE_API_KEY
```

```bash
gh secret set APPLE_API_ISSUER
```

`gh secret list` should now show all five names. GitHub never shows the values
again — keep the `.p8` and the export password in your password manager, then
delete `developer-id.p12` from disk. The certificate itself stays in your login
keychain, so you can export it again.

**5. Prove it before a release needs it.** Run a dry run and watch the two macOS
jobs:

```bash
gh workflow run release-please.yml --ref main
```

The summary should read *signing as "Developer ID Application: …"*, and the
*Verify signature and notarization* step should end with *Signed, notarized and
stapled.* The signed `.dmg`s are in the run's `installers-macos-*` artifacts.

### Check a release is signed and notarized

On any Mac, against a downloaded `.dmg` (`stapler` needs the Xcode command line
tools):

```bash
spctl -a -t open --context context:primary-signature -vv burnwright_<version>_aarch64.dmg
```

```bash
xcrun stapler validate burnwright_<version>_aarch64.dmg
```

And against the installed app:

```bash
spctl -a -t exec -vv /Applications/burnwright.app
```

```bash
codesign --verify --deep --strict --verbose=2 /Applications/burnwright.app
```

`spctl` should answer `accepted` with `source=Notarized Developer ID` and your name
and team ID as the origin; `stapler` should say *The validate action worked!*.
`scripts/macos/verify-signing.sh <dmg or app>` runs all of it, plus a check that
every binary in the bundle — the sidecar included — carries the hardened runtime
and a secure timestamp from the same team.

The test that counts is a clean Mac: download the `.dmg` with a browser, open it,
drag the app out, launch it. macOS still asks once whether to open an app from the
internet — and says Apple checked it for malicious software. That dialog is the
pass. *"Apple could not verify…"* is the fail.

### When a signed build fails

- **"Apple signing is half set up"** — a secret is missing or empty. The message names it.
- **"no valid Developer ID Application identity"** — the `.p12` holds the wrong kind of certificate, or the certificate without its private key. Re-export from *My Certificates*.
- **"couldn't import the .p12"** — `APPLE_CERTIFICATE_PASSWORD` doesn't match the export password.
- **Notarization fails** — a `401` from `notarytool` means the Key ID, Issuer ID and `.p8` don't belong together or the key was revoked. A status of `Invalid` means Apple rejected the build; the job prints Apple's log, which names the file and the reason.

Fix the secret and re-run just the failed jobs — the release and its other
installers are already there:

```bash
gh run rerun <run id> --failed
```

### Rotate or revoke

**The API key** — rotate it whenever you like. Revoke the old key in App Store
Connect (same page as step 3), generate a new one, and set `APPLE_API_KEY` and
`APPLE_API_KEY_P8` again. The Issuer ID doesn't change. Releases that are already
notarized aren't affected: the ticket is Apple's, not the key's.

**The certificate, on expiry** — create a new one, export it, and set
`APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` again. Builds signed with the
old one keep opening after it expires, because each signature carries Apple's
timestamp proving it was made while the certificate was valid.

**The certificate, if the `.p12` or its password leaks** — revoke it under
[Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list)
(Apple's developer support handles it if the portal won't). Know what that does
first: Gatekeeper starts refusing **every** build signed with that certificate,
including releases people already installed. It's the right call for a real leak
and the wrong one for routine rotation. Afterwards, create a new certificate and
cut a new release.

**Going back to unsigned** — delete all five secrets (`gh secret delete <name>`).
Deleting only some of them fails the next build on purpose.
