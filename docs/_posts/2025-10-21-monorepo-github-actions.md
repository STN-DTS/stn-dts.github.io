---
layout: post
title: Selective CI for monorepos -- detecting changes and running only the jobs you need
author: Greg Baker
date: 2025-10-21
categories: ci/cd github-actions monorepo
---

This post explains how a repository-level GitHub workflow can detect changes in
specific top-level folders and conditionally run jobs. It covers the
implementation details, why this pattern is useful for monorepos, when to apply
it, edge cases to watch out for, and alternative approaches.

## Workflow overview

The workflow uses a dedicated job called `detect-changes` that runs early and
outputs boolean signals indicating whether any files under particular folder
paths changed in the event that triggered the workflow. Downstream jobs
reference these outputs in `if` conditions so they only run when needed.

Key pieces in the example workflow (see the sample workflow at the end of this
post):

- `dorny/paths-filter@v3` action: used to check whether files changed under
  `backend/`, `frontend/`, and `gitops/`.
- `detect-changes` job outputs: the job exposes `backend-changed`,
  `frontend-changed`, and `gitops-changed` outputs that other jobs use.
- Conditional `if` checks on jobs: `if: ${{
  needs.detect-changes.outputs.backend-changed == 'true' }}` ensures a job runs
  only when the relevant folder changed.

The example workflow (see the sample at the end of this post) runs on `push` and
`pull_request` for `main` and `release/**` branches, and also supports manual
triggers. You can adapt the event filters to match your project's branching and
release model.

## How it works, step-by-step

1. checkout repository

   The `detect-changes` job runs `actions/checkout@v4` to fetch the commit(s)
   for the event. This is necessary because the paths-filter action needs the
   repository contents to determine which files were modified.

2. run `paths-filter` for each target folder

   The job calls `dorny/paths-filter@v3` with filters defined for each target
   folder, using glob patterns like `backend/**`. When the action runs it
   compares the current event's commit(s) against the base (for PRs) or previous
   commit (for pushes) to decide whether any matching files were
   added/modified/deleted.

3. expose outputs

   After running the filters the `detect-changes` job publishes outputs mapping
   to each step's `steps.{id}.outputs.src` value. The `src` output is set to
   `true` when matched and `false` otherwise. These outputs are available to
   jobs that declare `needs: detect-changes`.

4. downstream jobs use conditional `if`

   Jobs such as `test-backend`, `build-backend`, `test-frontend`,
   `build-frontend`, etc. declare `needs: detect-changes` and supply an `if`
   condition that checks the corresponding output. If the output is `true`, the
   job runs; otherwise it is skipped.

## Why use this pattern

- save CI minutes and costs: only run expensive compilation, test, and build
  steps when the code that matters actually changed.
- faster feedback for developers: pull requests that touch only docs or a small
  part of the repo don't block on unrelated jobs.
- clear separation of concerns: each top-level folder can have its own CI logic
  and matrix without duplicating the change-detection logic.
- monorepo friendly: common pattern used in monorepos that contain multiple
  services, SDKs, or components.

## When to apply it

- monorepos with multiple independent services or packages in separate
  directories.
- projects where builds or tests are expensive and should only run when relevant
  code changes.
- mixed-technology repositories (Java backend, TypeScript frontend, infra
  manifests) where selective runs reduce cross-impact.

If your repo has a small codebase with fast CI, the added complexity may not be
worth it.

## Branch Protections and Required Checks

This pattern enables effective branch protections by allowing you to set
required status checks that correspond to the conditional jobs. When configuring
branch protections in your repository settings, you can specify that certain
checks must pass before merging a pull request. Since the jobs only run when
their respective folders have changes, the required checks are only enforced
when relevant.

For example, you can require "ci/test-backend" and "ci/build-backend" to pass.
If a pull request only changes frontend code, these backend jobs will be
skipped, and GitHub will not consider them as failing or blocking the merge. The
pull request checks will show the skipped jobs, but they won't prevent merging.
This ensures that only the necessary validations run, speeding up the process
while maintaining quality gates for changed components.

To configure required checks, navigate to your repository's Settings > Branches,
select 'Add rule' or edit an existing one for your protected branch (eg:
`main`), and under 'Require status checks to pass before merging,' add the names
of the jobs you want to require (matching the job names in your workflow, such
as `ci/test-backend`).

Note that skipped jobs are displayed as "skipped" in the pull request status,
not as failures, so they don't cause the PR to be blocked.

## Implementation notes and best practices

- Checkout depth and fetch behavior: Change-detection actions like
  `dorny/paths-filter` may require the full Git history to accurately compute
  diffs. Use `fetch-depth: 0` in `actions/checkout` to fetch the complete
  history. Refer to the action's documentation for specific requirements.

- PRs vs pushes: For pull requests, change detection compares the PR branch to
  the base branch. For push events, it compares the new commit to the previous
  one. `dorny/paths-filter` handles these cases automatically, but be mindful of
  how merge commits or squash merges might influence the diffs.

- Matching globs: Be precise with glob patterns. `backend/**` matches everything
  under `backend/`. If you only want to detect changes to `src` subfolders,
  narrow it to `backend/src/**`.

- Multi-filter invocation vs single config: The example runs
  `dorny/paths-filter` multiple times with a single `src` filter each time.
  `dorny/paths-filter` also supports defining multiple filters in a single
  invocation; using a single invocation with multiple named filters reduces the
  number of steps and is slightly more efficient. The sample workflow below
  demonstrates a single-invocation approach.

- Action outputs are strings: Outputs from `dorny/paths-filter` are string
  values (`"true"` or `"false"`). Ensure your `if` conditions compare them as
  strings, e.g., `if: ${{ needs.detect-changes.outputs.backend-changed == 'true'
  }}`.

- Job ordering and `needs`: Downstream jobs must declare `needs: detect-changes`
  to access the outputs.

## Edge cases and pitfalls

- Changes that cross folder boundaries: if a change touches multiple folders,
  multiple outputs will be `true` and multiple jobs will run. That's expected,
  but it means a single PR can still trigger many jobs.

- Non-file changes that matter: some workflows want to trigger on changes to
  external resources (e.g., changes to build scripts or GitHub Actions files).
  If your CI depends on shared scripts, include those paths in the filters or
  create a separate filter that causes all jobs to run when shared infra
  changes.

- False negatives because of shallow clones: if `actions/checkout` is configured
  with a shallow fetch that doesn't include the previous commit, diff-based
  detection may fail. Use `fetch-depth: 0` when necessary.

- Relying on `paths-filter` internals: while `dorny/paths-filter` is
  well-maintained, it's a third-party action. You can reduce dependence by
  re-implementing change detection using `git diff` in a small script or by
  using a different action.

## Alternatives

- Native `paths` support on jobs: GitHub Actions supports `paths` and
  `paths-ignore` filters at the workflow-level for `push` and `pull_request`
  events, but these cannot conditionally run jobs inside a workflow based on
  multiple folder checks with shared detection logic. `paths` also can't express
  complex cross-folder logic as flexibly as an explicit detection job.

- Custom git diff step: Run a shell step that computes `git diff --name-only
  $BASE...$HEAD` and sets outputs using the `GITHUB_OUTPUT` environment file
  (e.g., `echo "changed=true" >> $GITHUB_OUTPUT`). This avoids third-party
  actions and can be tailored to your needs.

- Third-party monorepo tools: tools like Nx or Lerna provide sophisticated
  affected-project detection and can output lists of affected packages; they are
  useful for larger JS monorepos.

## Example changes to improve the sample workflow

- Use a single `dorny/paths-filter` invocation with multiple named filters
  instead of three separate steps. This simplifies the `detect-changes` job and
  makes the outputs cleaner (the sample below shows this).

- Add a `shared-changes` filter that matches `.github/workflows/**`, `docker/*`,
  or other infrastructure when you want to run everything on infra changes.

- Explicitly set `fetch-depth: 0` on `actions/checkout` in `detect-changes` to
  avoid shallow clone pitfalls (the sample uses `fetch-depth: 0`).

## Conclusion

Using a `detect-changes` job with `dorny/paths-filter` and conditional `if`
expressions provides a clear, maintainable way to run jobs only when relevant
parts of a monorepo change. It reduces CI costs and shortens feedback loops
while keeping the workflow flexible. For larger or more specialized monorepos,
complement this approach with monorepo-aware tooling or a custom git-diff
script.

Below is a generic, self-contained example workflow you can copy into
`.github/workflows/` or keep as a reference in the post.

``` yaml
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
```
