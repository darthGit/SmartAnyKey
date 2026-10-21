# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[0.1.2]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.2
[0.1.1]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.1
[0.1.0]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.0
