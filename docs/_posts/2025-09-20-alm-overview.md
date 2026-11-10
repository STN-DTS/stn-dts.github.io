---
layout: post
title: "How we ship: from branch to production"
author: Greg Baker
date: 2025-09-20
categories: alm devops git software-engineering
---

Every team wants to ship quickly without breaking production, and those two goals pull against each other. Over time
we've settled on a workflow that gives us a decent balance. This post walks through it in three parts: what we do day to
day, how we get ready for a release, and how the release actually reaches production.

## Day to day on `main`

We use [Trunk-Based Development](https://trunkbaseddevelopment.com/). In practice that means the `main` branch is the
source of truth, and everyone works to keep it healthy and ready to ship.

The daily routine is simple:

1.  Create a short-lived feature branch from `main`.
2.  Write some code, then open a Pull Request (PR) back to `main`.
3.  A GitHub Action automatically runs our test suite against the PR to catch issues early.

We merge PRs constantly, which raises an obvious question: what about features that aren't finished yet? For that we
lean on flags. A flag lets us merge incomplete work into `main` and keep it hidden from users until it's ready. That
way, deploying code and releasing a feature become two separate decisions.

We use two kinds of flags. A *feature flag* is small and controls one specific piece of functionality. A *future flag*
is broader and controls a whole set of features that belong to a bigger upcoming release. For example, a future flag
like `v2_profile-matching` could hide all the work for a major v2.0 feature, so we can keep merging that code long
before release day.

Once a PR is merged, our CI pipeline in TeamCity picks it up. For every commit to `main`, it:

1.  Lints and checks the formatting of the code.
2.  Runs all our unit and end-to-end (e2e) tests.
3.  Builds the application into a container image.
4.  Pushes that new image to our container registry.

The new image is then deployed automatically to our `dev` and `int` (integration) environments. `dev` is the simple one.
It uses mocked data and is good for quick checks. `int` is closer to the real thing: there, the app has to work with
other live services.

## Release branches

If `main` is always changing, how do we get something stable enough to release? A few days before a release, we create a
`release/vX.Y.Z` branch. This is our feature freeze. The branch is a stable snapshot where we focus only on final
testing and bug fixes. New development keeps going on `main`, but the release branch only gets small, critical fixes.

Pushing to a release branch triggers a separate TeamCity build. It runs the same tests, but it versions the container
image as a release candidate (RC), like `v1.0.0-RC001`. That RC build is what our User Acceptance Testing (UAT) team
reviews before giving final sign-off.

## Tagging and deploying with GitOps

Once UAT approves an RC, we're ready to go live:

1.  We tag the exact commit that UAT approved with the final version, like `v1.0.0`.
2.  That tag triggers one last TeamCity build, which creates the official production image.
3.  A developer updates a `deployments.yaml` file in our GitOps repo with the new version number.

GitOps means production is described by files in a Git repository, and an automated agent makes the real environment
match those files. In our case, the agent notices the change to `deployments.yaml`, pulls the new image, and rolls out
the update to production. Deploying is just a small, reviewed commit, so every production change has a clear record of
who changed what and when.

## Merging back to `main`

We're not quite done once the code is in production. Any critical bug fixes made on the release branch also need to end
up in `main`, or they'll be lost.

So once the new version is live and stable, we open one more PR to merge the `release/vX.Y.Z` branch back into `main`.
That brings any fixes made during the feature freeze back into our main line of development. The merge is usually
smooth, but we don't skip it. If we did, the same bugs could come back in a future release.

## Why it works for us

Trunk-based development keeps us moving quickly day to day. Release branches give us room to test and fix things before
we ship. GitOps gives us a clear, auditable record of every production deployment. Together they give us a good balance
between shipping fast and keeping production stable.
