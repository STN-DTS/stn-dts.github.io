---
layout: post
title: Selective CI for monorepos -- detecting changes and running only the jobs you need
author: Greg Baker
date: 2025-10-21
categories: ci/cd github-actions monorepo devops
---

In a monorepo, every pull request kicks off every CI job by default. Change one line in the frontend and you still wait
for the backend to compile and run its tests. In this post I'll show how we set up a GitHub Actions workflow that checks
which top-level folders changed and only runs the jobs for those folders. I'll also cover when it's worth doing, a few
gotchas, and some other ways to solve the same problem.

## How the workflow is set up

The workflow starts with a job called `detect-changes`. It checks whether any files changed under `backend/`,
`frontend/`, and `gitops/`, and publishes the answer as three outputs: `backend-changed`, `frontend-changed`, and
`gitops-changed`. (Job outputs are values one job can hand to the jobs that run after it.)

The actual change detection is done by the `dorny/paths-filter@v3` action. Every other job looks at one of those
outputs in an `if` condition, like `if: {% raw %}${{ needs.detect-changes.outputs.backend-changed == 'true' }}{% endraw %}`, and gets
skipped if its folder didn't change.

The full sample workflow is at the end of this post. It runs on `push` and `pull_request` for `main` and `release/**`
branches, and you can also trigger it by hand. Change the event filters to fit your own branching and release setup.

## Step by step

1. Check out the repo. The `detect-changes` job runs `actions/checkout@v4` to fetch the commits for the event. The
   paths-filter action needs the repository contents to work out which files changed.

2. Run `paths-filter`. The job calls `dorny/paths-filter@v3` with one named filter per folder, each using a glob
   pattern like `backend/**`. The action compares the current commits against the base branch (for pull requests) or
   the previous commit (for pushes) and checks whether any matching files were added, modified, or deleted.

3. Expose the outputs. The action sets an output for each named filter, for example `steps.paths.outputs.backend`.
   It's `true` if something matched and `false` if not. The `detect-changes` job passes these on as its own outputs, so
   any job that declares `needs: detect-changes` can read them.

4. Skip what didn't change. Jobs like `test-backend`, `build-backend`, `test-frontend`, and `build-frontend` declare
   `needs: detect-changes` and use an `if` condition that checks the matching output. If it's `true`, the job runs.
   Otherwise it's skipped.

## Why bother

The main reason is cost. Compiling, testing, and building are the expensive parts of CI, and there's no point paying for
them when the code they cover hasn't changed. It also means faster feedback: a pull request that only touches docs or
one small part of the repo doesn't have to wait on unrelated jobs.

It keeps things organized too. Each top-level folder can have its own CI jobs and build matrix, and they all share one
place for change detection instead of each repeating it. This is a common pattern in monorepos that hold several
services, SDKs, or components.

## When to use it

It's a good fit when your repo has several independent services or packages in separate folders, when builds or tests
are slow enough that skipping them matters, or when you mix technologies (say a Java backend, a TypeScript frontend, and
infrastructure manifests) and a change to one shouldn't trigger CI for the others.

If your codebase is small and CI is already fast, the extra complexity probably isn't worth it.

## Branch protection and required checks

This pattern plays nicely with branch protection rules. You can mark the conditional jobs as required status checks,
and they'll only be enforced when they actually run.

For example, say you require `ci/test-backend` and `ci/build-backend` to pass. If a pull request only changes frontend
code, those backend jobs are skipped, and GitHub doesn't treat them as failing or blocking the merge. They show up as
"skipped" in the pull request checks, not as failures. So you only run the checks you need, and the quality gates still
apply to the parts that changed.

To set up required checks, go to your repository's **Settings > Branches**, click **Add rule** (or edit the existing
rule for your protected branch, e.g. `main`), and under **Require status checks to pass before merging**, add the names
of the jobs you want to require. These need to match the job names in your workflow, such as `ci/test-backend`.

## Things to get right

**Fetch the full history.** Change-detection actions like `dorny/paths-filter` may need the full Git history to compute
diffs correctly. Set `fetch-depth: 0` on `actions/checkout` to get it. The action's documentation has the details. If
you use a shallow clone that doesn't include the previous commit, change detection can miss changes entirely. The
sample workflow already sets `fetch-depth: 0` in `detect-changes`.

**Pull requests vs. pushes.** For pull requests, the action compares the PR branch to the base branch. For pushes, it
compares the new commit to the previous one. `dorny/paths-filter` handles both cases for you, but keep in mind that
merge commits and squash merges can affect what shows up in the diff.

**Be precise with globs.** `backend/**` matches everything under `backend/`. If you only care about changes under
`backend/src`, use `backend/src/**` instead.

**One invocation or several.** You can call `dorny/paths-filter` once per folder, each with a single filter, but the
action also lets you define several named filters in one call. That's what the sample does. It means fewer steps, it's
a little more efficient, and the outputs are cleaner.

**Outputs are strings.** The outputs from `dorny/paths-filter` are the strings `"true"` and `"false"`, not booleans.
Your `if` conditions need to compare them as strings, e.g. `if: {% raw %}${{ needs.detect-changes.outputs.backend-changed == 'true' }}{% endraw %}`.

**Don't forget `needs`.** A job has to declare `needs: detect-changes` to read its outputs.

## Edge cases

If a pull request touches several folders, several outputs will be `true` and several sets of jobs will run. That's
what you want, but it does mean one PR can still trigger a lot of jobs.

Sometimes the changes that matter aren't in the folders you're watching. If your CI depends on shared build scripts or
on the GitHub Actions workflow files themselves, add those paths to your filters. Another option is a separate
`shared-changes` filter matching things like `.github/workflows/**` or `docker/*` that makes every job run when shared
infrastructure changes.

Finally, `dorny/paths-filter` is well maintained, but it's still a third-party action. If you'd rather not depend on it,
you can write the change detection yourself with `git diff` in a small script, or switch to a different action.

## Other ways to do it

GitHub Actions has built-in `paths` and `paths-ignore` filters for `push` and `pull_request` events, but they work at
the workflow level. They decide whether the whole workflow runs, so you can't use them to turn individual jobs on and
off from one shared detection step. They also can't express cross-folder logic as flexibly as a dedicated detection job.

You can also skip third-party actions entirely and add a shell step that runs `git diff --name-only $BASE...$HEAD`,
then sets outputs by writing to the `GITHUB_OUTPUT` file (e.g. `echo "changed=true" >> $GITHUB_OUTPUT`). That gives you
full control over the logic.

For larger JavaScript monorepos, tools like Nx or Lerna can work out which projects are affected by a change and give
you a list of them. They go well beyond what a simple folder check can do.

## Wrapping up

A `detect-changes` job using `dorny/paths-filter`, plus `if` conditions on the other jobs, is a simple and easy to
maintain way to run CI only for the parts of a monorepo that changed. It cuts CI costs and gets feedback to developers
faster. For bigger or more specialized monorepos, you can pair it with monorepo tooling or a custom `git diff` script.

Here's a complete example workflow. You can copy it into `.github/workflows/` and adapt it to your repo.

```yaml
{% raw %}
name: Build and test solution
permissions: read-all

on:
  push:
    branches:
      - main
      - 'release/**'
  pull_request:
    branches:
      - main
      - 'release/**'
  workflow_call: {}
  workflow_dispatch: {}

env:
  CI: true

jobs:
  detect-changes:
    name: ci/detect-changes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: paths
        uses: dorny/paths-filter@v3
        with:
          filters: |
            backend:
              - backend/**
            frontend:
              - frontend/**
            gitops:
              - gitops/**
    outputs:
      backend-changed: ${{ steps.paths.outputs.backend }}
      frontend-changed: ${{ steps.paths.outputs.frontend }}
      gitops-changed: ${{ steps.paths.outputs.gitops }}

  test-backend:
    name: ci/test-backend
    runs-on: ubuntu-latest
    needs: detect-changes
    if: ${{ needs.detect-changes.outputs.backend-changed == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - run: mvn clean verify
        working-directory: backend/

  build-backend:
    name: ci/build-backend
    runs-on: ubuntu-latest
    needs: detect-changes
    if: ${{ needs.detect-changes.outputs.backend-changed == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - run: mvn spring-boot:build-image
        working-directory: backend/

  test-frontend:
    name: ci/test-frontend
    runs-on: ubuntu-latest
    needs: detect-changes
    if: ${{ needs.detect-changes.outputs.frontend-changed == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.x
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - run: pnpm install --frozen-lockfile
        working-directory: frontend/
      - run: pnpm run typecheck
        working-directory: frontend/
      - run: pnpm run format:check
        working-directory: frontend/
      - run: pnpm run lint:check
        working-directory: frontend/
      - run: pnpm run test -- --coverage
        working-directory: frontend/
      - run: npx playwright install chromium --with-deps
        working-directory: frontend/
      - run: pnpm run test:e2e
        working-directory: frontend/

  build-frontend:
    name: ci/build-frontend
    runs-on: ubuntu-latest
    needs: detect-changes
    if: ${{ needs.detect-changes.outputs.frontend-changed == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.x
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - run: pnpm install
        working-directory: frontend/
      - run: podman build --file containerfile .
        working-directory: frontend/
{% endraw %}
```
