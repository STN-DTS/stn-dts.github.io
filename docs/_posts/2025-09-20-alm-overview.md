---
layout: post
title: "How we ship: from branch to production"
author: Greg Baker
date: 2025-09-20
categories: alm devops git software-engineering
---

Finding the sweet spot between moving fast and not breaking things is a classic developer dilemma. How do you ship features
quickly without causing chaos in production? We've worked hard to fine-tune a workflow that gives us the best of both worlds.
Here's a look at how we do it.

Our process breaks down into three parts: our daily development, how we prepare for a release, and how we finally deploy to
production.

## The daily grind: fast and furious on the `main` branch

At the heart of our daily work is [Trunk-Based Development](https://trunkbaseddevelopment.com/). For us, the `main` branch is
the source of truth, and we're all focused on keeping it healthy and ready to go.

Our day-to-day is pretty straightforward:

1.  Create a short-lived feature branch from `main`.
2.  Write some code, then open a Pull Request (PR) back to `main`.
3.  A GitHub Action automatically runs our test suite against the PR to catch issues early.

We merge PRs all the time. But what about half-finished features? We rely heavily on flags to manage this. This lets us merge
incomplete work into `main` safely, hiding it from users until it's ready. It's a great way to separate deploying code from
releasing a feature.

We generally use two types of flags. **Feature flags** are fine-grained and control a single, specific piece of functionality. A
more coarse-grained type of flag we use is a **future flag**. These are used to control a whole set of features that might be
part of a larger upcoming release. For example, a future flag like `v2_profile-matching` could hide all the work being done for
a major v2.0 feature, allowing us to integrate code long before the big release day.

As soon as a PR is merged, our CI pipeline in TeamCity takes over. For every single commit to `main`, it automatically:

1.  Lints and checks the formatting of the code.
2.  Runs all our unit and end-to-end (e2e) tests.
3.  Builds the application into a container image.
4.  Pushes that new image to our container registry.

From there, the image is auto-deployed to our `dev` and `int` (integration) environments. `dev` is our simple, no-fuss
environment with mocked data, perfect for quick checks. `int` is where things get real, and the app has to prove it can play
nicely with other live services.

## The safety net: release branches for smooth landings

So, if `main` is always moving, how do we prepare for a big release? When a release is just a few days away, we create a
`release/vX.Y.Z` branch. This branch is our "feature-freeze" zone.

Think of it as a stable snapshot where we can focus purely on final testing and bug fixes. While new development continues on
`main`, the release branch only gets small, critical fixes.

Pushing to a release branch kicks off a special TeamCity build. It runs the same tests, but it versions the container image as a
**Release Candidate (RC)**, like `v1.0.0-RC001`. This RC build is what our User Acceptance Testing (UAT) team reviews for the
final sign-off.

## The final mile: tagging and a GitOps hand-off

Once the UAT team gives the green light on an RC, we're ready to go live.

1.  **Tag it:** We tag the exact commit that UAT approved with the final version, like `v1.0.0`.
2.  **Build it:** That tag triggers one last TeamCity build to create the official production image.
3.  **Ship it (with GitOps):** For the final step—getting our code to production—we turn to GitOps. The process is surprisingly
    simple and incredibly safe. A developer just updates a `deployments.yaml` file in our GitOps repo with the new version
    number.

An automated agent spots the change, grabs the new image, and safely rolls out the update to production. It's a declarative,
auditable, and stress-free way to deploy.

## Closing the loop: merging back to main

The story doesn't end once the code is in production. What about the small, critical bug fixes that were made on the `release`
branch? We need to make sure they aren't lost and are included in the next wave of development.

This is where the final step comes in: merging the release branch back into `main`.

Once the new version is live and confirmed to be stable, we open a final PR to merge the `release/vX.Y.Z` branch back into
`main`. This ensures that any hotfixes applied during the feature-freeze are incorporated back into our primary line of
development. Usually, this merge is smooth, but it's a critical step to prevent those same bugs from reappearing in a future
release.

## It just works

So, what do we get from all this? Our trunk-based approach keeps us moving fast day-to-day. The release branches give us the
breathing room we need to ship with confidence. And GitOps provides a rock-solid, auditable trail for every production
deployment. It's a system that's worked well for us, giving us a great balance of developer velocity and production stability.
