# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-10-23

### Added

- Two-factor sign-in with an authenticator app (TOTP): set it up under
  **Sign-in security**, then each sign-in asks for a 6-digit code. The server
  enforces it for the API, remote sessions and data reads, not only the sign-in
  form.
- A 2FA policy under **Admin → Users**: required for everyone, operators and
  admins, admins only, or nobody. Admins can reset a user's 2FA;
  `scripts/reset-mfa.mjs` does it from the command line.

### Changed

- **Administrators must use 2FA by default**, on upgraded installs too: at the
  next sign-in an admin without an authenticator is asked to set one up. To
  keep the old behaviour, set the policy to "Nobody" under **Admin → Users**.

### Fixed

- Discovery runs at most one scan per site, whoever starts it: a second admin
  or the scheduled rescan joins the scan in progress instead of starting
  another nmap.
- Stop in the discovery drawer really stops the scan: nmap is killed, the run
  ends as stopped, and every open drawer shows it.

## [0.3.1-rc.1] — 2026-10-23

A pre-release that tests the new release pipeline; it changes nothing in the app.

### Changed

- Release images are published only after the release has been installed on a
  clean machine and an install of the previous release has been updated to it;
  the release notes are taken from this file.

## [0.3.0] — 2026-10-22

### Added

- Discovery and Teach the classifier show scan progress while a scan runs:
  the stage and nmap's own progress, e.g. "Finding hosts · Ping Scan 66%",
  then "Scanning services · Service scan 42%".
- Device types carry a set of protocols (VNC, RDP, SSH, web). New devices of
  the type get all of them — from discovery, import or manual add, where
  picking the type ticks them and you can untick for one device.
- "Apply to devices" on a device type adds its protocols to the existing
  devices that miss them, after a confirmation that shows how many. It only
  adds; protocols set by hand on a device stay.
- The device type list shows each type's protocols and sort order.

### Fixed

- Discovery missed hosts that drop ICMP and have ports 80/443 filtered (e.g. a
  Windows machine with 135/445/3306/5900 open): the same hosts were missing
  from classification and from Teach the classifier. Hosts are now detected by
  a TCP connect to the scanned ports, and the service scan no longer drops them
  again.
- An SSH session drew full-screen programs (e.g. `mc`) in an 80×24 box: the
  terminal size sent while the session was connecting was lost. The terminal
  now gets the size of its pane.

## [0.2.0] — 2026-10-22

### Added

- Discovery rules: an `ip_range` pattern that starts with `^` is a regular
  expression tested against the host IP, so one rule can cover the same host
  addresses in every branch subnet (e.g. `^(?:192|10)\.168\.\d{1,3}\.25[0-4]$`).
  Other patterns are CIDR or a single IP, as before.
- Discovery: pick the device type for each host before adding it — change the
  type the classifier proposed, or add a host no rule matched by choosing its
  type by hand.

### Fixed

- Discovery: closing the window no longer loses a running scan. Reopening the
  point (or reloading the page) shows that scan or its result instead of
  starting a new one.
- Discovery: the "Added N" result stays visible after the last host is added.

## [0.1.2] — 2026-10-21

### Fixed

- The 0.1.1 installer stopped at the first step with
  `bootstrap: unknown flag: --from-installer`, both on a new install and on an
  upgrade.

### Added

- `./docker/install.sh --update` upgrades an existing install: new images and a
  restart, without the install steps (secrets, address, first admin). The
  "Update available" window shows this command.

## [0.1.1] — 2026-10-21

Fixes from installing the public release on a clean machine.

### Added

- Discovery: tick the hosts to add and name them by hand or from a template
  (`Till {n}` → Till 1, Till 2, …), then add the selected ones in one click.
- Discovery: hosts that answer with the same SSH host key (machines cloned from
  one image) are marked, since each can impersonate the other.
- "Teach the classifier" has its own page in the admin menu, and the scan's
  "no rule" hint links to it.
- Devices admin works by site: pick a site once (kept in the address,
  `?point=<number>`), see its devices with the credential state per protocol,
  add devices to it; search still finds a device on any site. The site card
  links to it.
- The admin menu shows the running version; a newer release shows an
  "Update available" button with the release notes and the upgrade commands.
  The server checks GitHub once a day — set `SAK_UPDATE_REPO=` (empty) in
  `docker/.env` to turn this off.

### Fixed

- A cloned machine was taken for the device it was cloned from and could not be
  added; a key shared by two scanned hosts no longer identifies either.
- Back on admin pages returned to the board instead of the previous page.
- Re-running the installer to upgrade kept the old images: it now pulls them
  first. Upgrading is `git pull` and re-running `./docker/install.sh`
  (see docs/operations.md).

## [0.1.0] — 2026-10-15

First public release.

### Added

- Board of sites and devices with search by number, address, device, IP, note
  and contact phone.
- SSH, VNC and RDP sessions in the browser, several at once in a tiling layout;
  SFTP file manager on SSH devices.
- Credential manager: named sets resolved device → type → site → global,
  AES-256-GCM at rest, access log.
- Auto-discovery: subnet scan, rule-based classification, propose-then-confirm
  diff, scheduled rescans with a drift inbox.
- Site card: live device status, contacts, notes, runbooks.
- Scheduled tasks: Python, Node and shell scripts on cron or webhook, cached
  dependencies, live log, artifacts; built-in database backup.
- Roles (viewer, operator, admin) enforced by row-level security and the API.
- One-command install from release images, backup and restore scripts.
- English and Ukrainian interface.

### Security

- Rate limiting on sign-in and on opening sessions; self-signup disabled.
- Content-Security-Policy, frame protection, HSTS behind TLS.

[0.3.0]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.3.0
[0.2.0]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.2.0
[0.1.2]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.2
[0.1.1]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.1
[0.1.0]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.0
