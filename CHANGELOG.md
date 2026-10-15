# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/darthGit/SmartAnyKey/releases/tag/v0.1.0
