# Security policy

SmartAnyKey stores credentials for every device it reaches, so security reports
get priority over everything else.

## Supported versions

| Version | Supported |
| :------ | :-------- |
| 0.1.x   | yes       |

Only the latest release receives fixes. Upgrade by re-running the installer with
the new tag — see [docs/operations.md](docs/operations.md).

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting instead:
open the **Security** tab of this repository and choose **Report a vulnerability**.
The report is visible only to you and the maintainers.

Helpful to include:

- the version (image tag) and how it is deployed (behind TLS or not, reverse proxy);
- what an attacker needs (network position, a user account and its role);
- steps to reproduce, and what you observed.

The fix is released as a new version, and the advisory is published together
with it, crediting you unless you prefer otherwise.

## Scope

In scope: the application, its API, the bundled `docker/` configuration and the
release images. Third-party services the stack runs (Postgres, Supabase
components, guacd) are in scope as far as our configuration of them goes;
vulnerabilities in those projects themselves belong upstream.
