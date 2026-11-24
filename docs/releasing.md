# Releasing

How a version of `@paidfor/x402-safe-fetch` gets from a branch to npm. Rollout step 2 of the release automation design
in paidfor-index (`docs/strategy/design/2026-11-24-release-automation.md`, issue
[sarmadahsan/paidfor-index#80](https://github.com/sarmadahsan/paidfor-index/issues/80)). The hand process (`pnpm publish`
from a terminal, behind npm 2FA) keeps working as the fallback.

## One PR per release

1. A branch bumps `version` in `package.json`, renames the `## Unreleased` section of `CHANGELOG.md` to
   `## <version>` (or adds one), and carries the code. Nothing else is edited by hand: no tag, no release.
2. CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`,
   `pnpm test` (build first: the examples resolve the package's types from `dist`), and checks that `CHANGELOG.md`
   has a section for the version in `package.json`.
3. CodeRabbit reviews; the owner merges. The merge is the release decision.
4. `.github/workflows/release.yml` runs on the push to `main`, in the `release` environment, and does the rest:
   a. Reads the version and looks up what already holds: tag `v<version>`, the version on npm, the GitHub release,
      and whether npm `latest` is the newest published version. When all hold, it stops. It also fails at once if
      the runner's npm is below 11.5.1, the floor for trusted publishing.
   b. Tags `v<version>` at the pushed commit, but only when this push changed the version line of `package.json`
      (`git diff <before> <after> -- package.json`). A push that did not change the version, and finds no tag,
      stops with nothing published. A tag is never moved or deleted by the workflow.
   c. Checks out the tagged commit, extracts its `CHANGELOG.md` section (a missing section fails here, before
      anything is published), installs, builds, typechecks and tests.
   d. `npm publish --provenance --access public` through the npm trusted publisher: no token anywhere, no 2FA
      prompt. Skipped when npm already serves the version. A version older than npm `latest` (a retry that a later
      release overtook) is published with `--tag previous`, so `latest` never moves backwards. The package's
      `prepublishOnly` script (`pnpm build && pnpm typecheck && pnpm test`) runs as part of the publish, as it does
      for a hand publish.
   e. Waits until `https://registry.npmjs.org/@paidfor/x402-safe-fetch/<version>` answers 200, up to five minutes.
   f. Repairs npm `latest` with `npm dist-tag add` when it is behind the newest published version (a hand publish
      that raced the workflow). This needs npm 11.21.0 or 12.2.0 on the runner; with an older npm the step fails
      and prints the one `npm dist-tag add` command to run by hand.
   g. Creates the GitHub release on the tag with the `CHANGELOG.md` section as its notes. Skipped when it exists.

Expected time after the merge: five to eight minutes.

The only secret-like thing in the chain is the job's own OIDC token, issued per run. The `release` environment with
its deployment branch rule (`main` only) is what ties every publish to a merge: npm matches the trusted publisher by
repository, workflow file name and environment name, never by branch, so the publish job must always carry
`environment: release`.

## The owner's one-time npm setup

On the day of the next release (0.8.1 or 0.9.0). A new trusted publisher expires if its first publish does not
happen within 2 days, so either do this the day the release PR merges, or prove the pipe with a no-op patch release
the same day (open question 8 of the design doc).

- [ ] On npmjs.com, open the package `@paidfor/x402-safe-fetch`, then Settings.
- [ ] Add a trusted publisher: provider GitHub Actions, organization or user `sarmadahsan`, repository
      `paidfor-client`, workflow filename `release.yml`, environment name `release`.
- [ ] Under the trusted publisher's allowed actions, tick `npm publish` and `npm dist-tag`. A new trusted publisher
      allows only `npm stage publish` until `npm publish` is ticked; without it the publish step fails.
- [ ] Turn on "Require two-factor authentication and disallow tokens". Trusted publishing keeps working; a hand
      publish keeps working with 2FA; a stolen token can do nothing.
- [ ] On GitHub, Settings, Environments, `release`: confirm the deployment branch rule lists `main` and nothing else.
      No required reviewer (open question 3 of the design doc: the merge is the click).

Then merge the release PR and watch Actions, Release.

### A dry run first

After the PR that adds the workflow merges, start Release by hand once: Actions, Release, Run workflow, branch
`main`. 0.8.0 is already on npm, so the run should create tag `v0.8.0` at the tip of `main` and the GitHub release
`v0.8.0` with the 0.8.0 changelog section, and publish nothing (steps a, b, c and g run; d, e and f are skipped).
This needs no npm setup and proves the environment, the tag push and the release creation.

## When a run fails

Every step checks what already holds, so the fix is almost always to re-run the same run (Actions, Release, the
failed run, Re-run all jobs). A re-run checks out its original commit.

- **The publish step fails with an authentication or permission error.** The trusted publisher is missing,
  expired (2 days unused), or `npm publish` is not among its allowed actions. Fix it on npmjs.com, re-run. Until it
  is fixed, `pnpm publish` by hand from the tagged commit (`git checkout v<version>`) still works; the next run then
  finds the version on npm and finishes the GitHub release.
- **A tag exists but npm has no such version.** A publish to retry, never a version to skip. Re-run the run.
- **The tagged commit fails typecheck, test or build.** The version is spent: nothing was published, and the fix
  goes out as the next patch version in a new release PR. Do not move the tag.
- **The run says the release run was lost** (the tree's version is on neither npm nor a tag, and the push did not
  change the version). Re-run the run of the push that introduced the version. When that run is gone, start
  Release by hand on `main`; a dispatch tags the tip of `main`, which only holds commits the owner merged.
- **Two pending runs.** Runs are queued in order (`concurrency` with `queue: max`); a later push with the same
  version in the tree finds the tag and stops. Nothing to do.
- **npm `latest` is wrong** after a hand publish raced the workflow. Re-run; step f repairs it when the runner's
  npm allows, and otherwise prints the `npm dist-tag add` command to run by hand with 2FA.
- **`CHANGELOG.md` has no section for the version.** CI catches this on the PR. If it reaches `main` anyway, the run
  fails after tagging and before publishing; add the section in a new PR and re-run.
