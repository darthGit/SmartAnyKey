# Contributing

Thanks for taking the time. Bug reports, fixes and ideas are all welcome.

## Before you start

- **Questions and ideas** — start a thread in
  [Discussions](https://github.com/darthGit/SmartAnyKey/discussions).
- **Bugs** — open an issue with the bug template; include the image tag and the
  steps to reproduce.
- **Security problems** — never in a public issue; see [SECURITY.md](SECURITY.md).
- **Larger changes** — open an issue first, so we can agree on the approach
  before you spend time on code.

## Development setup

[docs/development.md](docs/development.md) brings up the stack with fake SSH,
VNC and RDP targets and seeds demo data. In short:

```bash
pnpm install
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  --env-file docker/.env up -d
pnpm dev:seed
pnpm dev
```

## Making a change

- Code, comments, test names and commit messages are in English. User-facing
  text goes through the locale files in `i18n/locales/` — add the string to every
  locale.
- Keep nothing deployment-specific in source: addresses, names, ports and limits
  belong in configuration.
- Add or update a test with the change. Before opening a pull request:

  ```bash
  pnpm lint
  pnpm test        # needs the dev stack; pnpm test:ci runs without it
  ```

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(scope): …`, `fix(scope): …`, `docs: …`.
- UI changes: attach a screenshot to the pull request.

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
