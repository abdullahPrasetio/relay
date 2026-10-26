# Releasing Relay

Operational runbook for signed builds and the auto-update channel. Everything
here is optional: without secrets the CI workflow still builds and uploads
unsigned artifacts.

## Repository secrets

Configure under **Settings → Secrets and variables → Actions**.

| Secret | Purpose |
|---|---|
| `CSC_LINK` | macOS Developer ID Application certificate (`.p12`, base64 or URL) |
| `CSC_KEY_PASSWORD` | Password for `CSC_LINK` |
| `WIN_CSC_LINK` | Windows code-signing certificate (`.pfx`, base64 or URL) |
| `WIN_CSC_KEY_PASSWORD` | Password for `WIN_CSC_LINK` |
| `APPLE_ID` | Apple Developer account email (notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

`CSC_IDENTITY_AUTO_DISCOVERY` is derived in the workflow: it is `true` only
when `CSC_LINK` or `WIN_CSC_LINK` exists. With no certificate secrets the
build stays unsigned and identity discovery stays off.

## macOS: signed + notarized build

1. Export the Developer ID Application certificate as `.p12` and base64 it:
   `base64 -i cert.p12 | pbcopy` → `CSC_LINK`.
2. Set `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.
3. Run the build on macOS:
   ```bash
   npm run dist
   ```
   or publish directly:
   ```bash
   GH_TOKEN=... npm run release
   ```
4. electron-builder enables the hardened runtime
   (`build/entitlements.mac.plist`), signs with the Developer ID identity, and
   notarizes when all `APPLE_*` variables are present. Without `APPLE_*` the app
   is only signed; Gatekeeper warns until a notarized build is produced.
5. Verify: `spctl -a -vvv release/mac*/Relay.app` should report
   `accepted, source=Notarized Developer ID`.

Notarization runs only when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` are all set; otherwise electron-builder silently skips it.

## Windows signing

Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. electron-builder signs the NSIS
installer and the packaged executables. Without them, `npm run dist:win`
produces an unsigned `.exe` (SmartScreen warns on first run).

## Auto-update channel

- The feed is **GitHub Releases**, declared as `build.publish` in
  `package.json` (`abdullahPrasetio/relay`).
- electron-updater reads `latest.yml` (Windows), `latest-mac.yml` (macOS), and
  `latest-linux.yml` (Linux) from the latest release. Those files are produced
  only when electron-builder publishes (`--publish always`, e.g.
  `npm run release`), not by the CI build's `--publish never`.
- Upload the installers **and** the matching `latest*.yml` / `.blockmap` files
  to the same release.
- Runtime behavior: `electron/updater.js` checks only when
  `app.isPackaged` is true and `RELAY_DISABLE_UPDATER` is not `1`. Downloads are
  automatic; the user is asked before `quitAndInstall()`.
- Set `RELAY_DISABLE_UPDATER=1` in the environment to disable checks for a
  broken release.

### macOS limitation

Squirrel.Mac refuses to install an update over an unsigned app. Unsigned mac
builds (the CI default when no Apple secrets exist) can download an update but
cannot apply it. Signed **and** notarized builds are required for macOS
self-update. Additionally, the mac target currently builds a `.dmg` only;
electron-updater's macOS updater consumes the `.zip` artifact, so add a `zip`
target to `build.mac.target` before relying on mac auto-update.

## Version bump and tag

1. Bump `version` in `package.json` (semver; electron-updater only offers newer
   versions).
2. Commit, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The `release` job attaches artifacts to the GitHub release for the tag. If
   you need update metadata, publish locally with `npm run release` instead, or
   attach the generated `latest*.yml` files to the release manually.

## Rollback

electron-updater only moves clients forward, so "rolling back" means shipping a
higher version with the old code:

1. Revert the offending change and bump `version` to a value greater than the
   bad release (e.g. bad `0.2.1` → new `0.2.2`).
2. Tag and build as usual; clients on `0.2.1` will update to `0.2.2`.
3. Optionally delete or mark the bad GitHub release as a pre-release so new
   installs do not download it. Do not expect clients to downgrade to an older
   `latest*.yml`; they won't.
4. For an urgent stop, set `RELAY_DISABLE_UPDATER=1` in a hotfix or remove the
   release's `latest*.yml`; already-downloaded updates still need the user to
   restart.
