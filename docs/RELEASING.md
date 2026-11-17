<h1 align="center">
  <img src="../resources/icon.png" width="64" alt=""><br>
  Releasing Humbler
</h1>

## What a release contains

| File | What it is |
|---|---|
| `Humbler-Setup-<v>.exe` | Windows **full setup**: choose the folder, and install for just you or everyone. |
| `Humbler-QuickSetup-<v>.exe` | Windows **one-click setup**: installs for you straight away, no questions. |
| `Humbler-<v>-win-x64.zip` | Windows without an installer: unzip anywhere and run `Humbler.exe`. |
| `Humbler-<v>-linux-x86_64.AppImage` | Linux: make it executable and run it. |
| `Humbler-<v>-linux-x64.tar.gz` | Linux without AppImage: unpack and run `humbler`. |
| `Humbler-<v>-mac-arm64.dmg` / `-x64.dmg` | macOS for Apple Silicon / Intel (`.zip` versions too). |
| `latest*.yml`, `*.blockmap` | What installed copies update from. |
| `SHA256SUMS*.txt` | Checksums of the files. |

Both Windows setups install the same app, and either can update an install
made by the other. Uninstalling keeps your data.

**Where an installed Humbler keeps its data** (login, keys, settings, log):
`%APPDATA%\Humbler` on Windows, `~/Library/Application Support/Humbler` on
macOS, `~/.config/Humbler` on Linux. Running from source keeps using
`data/` in the project, so your development data and an installed copy
never mix. To move your data into an installed copy, copy the contents of
`data/` into that folder while both are closed. The encrypted keys and login
only open under the same Windows account, because they use its encryption
key (in `electron-userdata/Local State`, which is copied along).

## Building locally

```
npm run dist          # this OS
npm run dist:win      # Windows: both setups and the zip
npm run dist:linux    # Linux: AppImage and tar.gz
npm run dist:mac      # macOS (on a Mac)
```

Files go to `release/<version>/`. Windows and Linux files can both be built
on Linux (with Wine for the Windows ones); macOS files need a Mac.

## Making a release

1. Bump `version` in `package.json` (for example `0.2.0`) and commit.
2. Tag it with the same version and push the tag:
   ```
   git tag v0.2.0
   git push origin main v0.2.0
   ```
   Push the tag to each remote (GitHub and Gitea) that should publish it.
3. The **Release** workflow builds every platform and publishes the release
   with all the files. A tag with a hyphen (`v0.2.0-beta.1`) is published as
   a prerelease.

The workflow stops if the tag doesn't match `package.json`'s version.

### GitHub (`.github/workflows/`)

- `ci.yml`: every push and pull request: typecheck and build.
- `release.yml`: on a `v*` tag: Windows and Linux each on their own runner,
  then the release with their files and `SHA256SUMS.txt`.
- `release-mac.yml`: on the same tag: macOS on its own runner, then its files
  and `SHA256SUMS-mac.txt` are added to that release. Mac runners are slow
  and sometimes stuck in a queue, so this one never holds up Windows and
  Linux; whichever finishes first creates the release.

Either can be run by hand for an existing tag (Actions → Release, or
Release (macOS) → Run workflow), for example to retry just the Mac build.

Nothing to set up; it uses the built-in token.

### Gitea (`.gitea/workflows/`)

- `ci.yml`: every push and pull request: typecheck and build.
- `release.yml`: on a `v*` tag: Linux and Windows, built on one Linux runner
  in `electronuserland/builder:wine`; macOS only if you have a Mac runner.

It needs Actions enabled for the repository and a runner with the
`ubuntu-latest` label that can run Docker containers. Nothing else: it uses
the job's automatic token to publish. Optional extras:

- Secret **`RELEASE_TOKEN`**: only if your Gitea refuses the automatic token
  release access. A Gitea access token with repository read and write (your
  settings → Applications → Generate new token).
- Variable **`MAC_RUNNER`**: your Mac runner's label, to build macOS too.
- Variable **`RELEASE_FEED`**: another update feed, or `none` (see below).

## "A new version is available"

An installed Humbler checks for a newer release when it starts and every 12
hours. When one is out, a green update icon appears in the top bar (and a
☰ menu entry), with:

- **Install v<x> and restart**: downloads the new version, checks it against
  the release's `latest.yml` (sha512), installs it silently and starts it.
  Works for copies installed by either Windows setup (per-user or
  per-machine) and for the Linux AppImage. It waits until no sync or
  downloads are running.
- **Open the release page**: for everything else. The Windows zip and the
  Linux tar.gz can't replace themselves, and macOS needs a signed build
  before it can install updates.

Where it looks: the releases of the repository it was built from. The
build works that out and stores it inside the built app:

- **Built by GitHub Actions or Gitea Actions:** the repository the workflow
  runs in, on that server. A fork checks and installs from its own releases.
- **Built locally:** the `origin` git remote (GitHub, or a Gitea server).
- **Running from source:** the `origin` git remote too.

Set the Gitea variable **`RELEASE_FEED`** (or `HUMBLER_RELEASE_FEED` for
`npm run dist` or `npm run dev`) to another "latest release" API URL to check
there instead, or to `none` to turn the check off. Installing works with
GitHub and Gitea feeds; it downloads from the release the check found, on
the same server. The release must carry `latest.yml` (Windows),
`latest-linux.yml` (AppImage) and the `.blockmap` files. Both release
workflows upload them.

**Public or private Gitea.** A repository anyone can read needs nothing.
For a private one, each user adds an access token in **Settings → Updates**
(Gitea: your settings → Applications → Generate new token, with repository
read access). It's stored encrypted like your keys, never built into the
app, and sent only to the feed's own server: for the check and for
downloading the release's files (a redirect to another server drops it).
Settings → Updates also shows the feed, when it last answered, and why a
check failed. Private GitHub repositories aren't supported: GitHub serves
release files to signed-in browsers only.

A feed must be `https://`, except on your own network (a LAN address or a
`.local`/`.lan` name), where `http://` is allowed.

Drafts and prereleases are never announced. To try the check from source:
`HUMBLER_CHECK_UPDATES=1 npm run dev` (installing needs an installed copy).


## Signing (later)

Builds are unsigned for now: Windows SmartScreen says "Windows protected your
PC" (More info → Run anyway), and macOS asks you to right-click → Open the
first time. Signing turns on by itself when these secrets exist (GitHub:
Settings → Secrets → Actions; Gitea: Settings → Actions → Secrets):

| Secret | For |
|---|---|
| `WIN_CSC_LINK` | Windows code-signing certificate (`.pfx`), base64-encoded |
| `WIN_CSC_KEY_PASSWORD` | its password |
| `CSC_LINK` | Apple "Developer ID Application" certificate (`.p12`), base64-encoded |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization |

## Hardening in installed builds

Packaged builds have Electron's fuses set (electron-builder.yml): no running
as plain Node, no `NODE_OPTIONS` or `--inspect`, app code only from its own
signed-in-place archive (with integrity checking), and the cookie store
(your Humble login) encrypted with the OS's per-user key. A `.env` file is
ignored by installed builds.
