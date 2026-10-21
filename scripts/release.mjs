// SmartAnyKey image release — CI-agnostic (tier Full without GitHub Actions).
// The same call is made by a human, GitHub Actions, GitLab CI, Woodpecker or
// cron: no prompts, no TTY, the exit code says it all. That is why the repo has
// no `.github/workflows/*` — the CI provider is a property of the installation,
// not our knowledge (deployment-specific, belongs in config).
//
//   node scripts/release.mjs [tag] [--no-push] [--multi-arch]
//
//   tag           explicit tag; without it — `git describe --tags --always --dirty`
//   --no-push     build only (local check; pushing to GHCR is a separate step)
//   --multi-arch  linux/amd64 + linux/arm64. ⚠ Requires a push: a multi-platform
//                 result does not land in a local docker image, only in a registry.
//                 Needs a buildx builder with QEMU and adds substantial build time.
//
// Image names come from env (a client in a closed network is entitled to their
// own registry) — the same variables docker/docker-compose.yml reads.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const APP_IMAGE = process.env.SAK_IMAGE || 'ghcr.io/darthgit/smartanykey-app'
const EXECUTOR_IMAGE = process.env.SAK_EXECUTOR_IMAGE || 'ghcr.io/darthgit/smartanykey-executor'

/** Pure parser — argument order is free, the tag = the first non-flag. */
export function parseArgs(argv) {
  const flags = argv.filter(a => a.startsWith('--'))
  const rest = argv.filter(a => !a.startsWith('--'))
  const unknown = flags.filter(f => !['--no-push', '--multi-arch'].includes(f))
  if (unknown.length)
    throw new Error(`unknown flag: ${unknown.join(', ')}`)
  if (rest.length > 1)
    throw new Error(`expected one tag, got: ${rest.join(', ')}`)

  const multiArch = flags.includes('--multi-arch')
  const push = !flags.includes('--no-push')
  if (multiArch && !push)
    throw new Error('--multi-arch is incompatible with --no-push: a multi-platform image can only be pushed, it does not materialize locally')
  return { tag: rest[0], push, multiArch }
}

/** README and install.sh default to `latest`, so only a stable vX.Y.Z moves it;
 *  a pre-release or a dirty build must never become what a fresh install pulls. */
// The image bakes its release in (Dockerfile SAK_VERSION → NUXT_APP_VERSION) for the update badge.
export const buildArgs = tag => ['--build-arg', `SAK_VERSION=${tag}`]

export function tagsFor(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag) ? [tag, 'latest'] : [tag]
}

function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (res.error)
    throw new Error(`${cmd}: ${res.error.message}`)
  if (res.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} → exit ${res.status}${capture ? `\n${res.stderr}` : ''}`)
  return (res.stdout || '').trim()
}

export function resolveTag(explicit) {
  if (explicit)
    return explicit
  // `--dirty` on purpose: a `…-dirty` tag in the registry is a visible signal
  // that an uncommitted tree was pushed, not a silent match with a clean tag.
  return run('git', ['describe', '--tags', '--always', '--dirty'], { capture: true })
}

/** buildx is not everywhere (the developer's machine lacked it on 2026-09-04) —
 *  and single-arch does not need it. So: classic `docker build` by default,
 *  buildx only when really needed (multi-arch). Fewer prerequisites = the
 *  script runs on any runner with bare docker. */
function hasBuildx() {
  const res = spawnSync('docker', ['buildx', 'version'], { encoding: 'utf8', stdio: 'pipe' })
  return !res.error && res.status === 0
}

function build({ image, context, dockerfile, tag, push, multiArch }) {
  const refs = tagsFor(tag).map(t => `${image}:${t}`)
  const tags = refs.flatMap(r => ['-t', r])
  const df = dockerfile ? ['-f', dockerfile] : []
  console.log(`\n▶ ${refs.join(', ')}${multiArch ? ' (amd64+arm64)' : ''}${push ? ' → push' : ' → local'}`)

  if (multiArch) {
    // Multi-platform exists only in a registry, hence always `--push` here
    // (parseArgs already rejects `--multi-arch --no-push`).
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', ...tags, ...df, ...buildArgs(tag), '--push', context])
    return
  }
  run('docker', ['build', ...tags, ...df, ...buildArgs(tag), context])
  if (push) {
    for (const ref of refs)
      run('docker', ['push', ref])
  }
}

async function main(argv) {
  const { tag, push, multiArch } = parseArgs(argv)
  const resolved = resolveTag(tag)
  if (multiArch && !hasBuildx())
    throw new Error('--multi-arch needs docker buildx, which is missing. Install the plugin (e.g. `docker-buildx`) or build single-arch without the flag.')

  build({ image: APP_IMAGE, context: '.', dockerfile: 'Dockerfile', tag: resolved, push, multiArch })
  build({ image: EXECUTOR_IMAGE, context: 'executor', tag: resolved, push, multiArch })

  console.log(`\n✓ ${resolved}: ${APP_IMAGE}, ${EXECUTOR_IMAGE}${push ? ' (pushed)' : ' (local)'}`)
  if (!push)
    console.log('  not pushed (--no-push)')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  }
  catch (e) {
    console.error(`release: ${e.message}`)
    process.exit(1)
  }
}
