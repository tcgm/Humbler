# Releasing Humbler

## What a release contains

| File | What it is |
|---|---|
| `Humbler-Setup-<v>.exe` | Windows **full setup**: choose the folder, and install for just you or everyone. |
| `Humbler-QuickSetup-<v>.exe` | Windows **one-click setup**: installs for you straight away, no questions. |
| `Humbler-<v>-win-x64.zip` | Windows without an installer: unzip anywhere and run `Humbler.exe`. |
| `Humbler-<v>-linux-x86_64.AppImage` | Linux: make it executable and run it. |
| `Humbler-<v>-linux-x64.tar.gz` | Linux without AppImage: unpack and run `humbler`. |
| `Humbler-<v>-mac-arm64.dmg` / `-x64.dmg` | macOS for Apple Silicon / Intel (`.zip` versions too). |
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
- `release.yml`: on a `v*` tag: Windows, Linux and macOS each on their own
  runner, then one release with every file and checksums. It can also be run
  by hand (Actions → Release → Run workflow) for an existing tag.

Nothing to set up; it uses the built-in token.

### Gitea (`.gitea/workflows/`)

For a private Gitea server. The workflow files are pushed to GitHub too, so
they contain no server address, names or tokens: the server's address comes
from the runner at run time (`gitea.server_url`) and the token from a secret
stored in Gitea. Keep it that way; anything private belongs in Gitea's
secrets and variables, never in the repository.

- `ci.yml`: every push and pull request: typecheck and build.
- `release.yml`: on a `v*` tag: Linux and Windows, built on one Linux runner
  in `electronuserland/builder:wine`; macOS only if you have a Mac runner.

Setup, once:

1. Enable Actions for the repository and have a runner with the
   `ubuntu-latest` label that can run Docker containers.
2. Add the secret **`RELEASE_TOKEN`**: a Gitea access token with read and
   write access to repositories (your settings → Applications → Generate new
   token). Gitea doesn't allow secret names starting with `GITEA_`.
3. Optional, for macOS: add the repository variable **`MAC_RUNNER`** set to
   your Mac runner's label.
4. Optional: the repository variable **`RELEASE_FEED`** (see below).

## "A new version is available"

An installed Humbler checks for a newer release when it starts and every 12
hours, and shows an **Update** pill and a ☰ menu entry that open the release
page. It downloads nothing.

Where it looks is never written in the repository. The build works it out
and stores it only inside the built app:

- **Built by GitHub Actions:** that repository's releases
  (`https://api.github.com/repos/<owner>/<repo>/releases/latest`, from the
  runner's `GITHUB_REPOSITORY`). Nothing to set.
- **Built by Gitea:** no check, unless you set the Gitea repository variable
  **`RELEASE_FEED`** to a feed URL. Point it at the public GitHub feed above
  so copies built at home hear about public releases. Pointing it at your own
  server's API puts that address inside every installer Gitea builds.
- **Built locally:** no check, unless you set `HUMBLER_RELEASE_FEED` when
  running `npm run dist`.

Drafts and prereleases are never announced. To try the check from source:
`HUMBLER_CHECK_UPDATES=1 HUMBLER_RELEASE_FEED=<url> npm run dev`.


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
