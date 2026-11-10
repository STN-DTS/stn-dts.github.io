---
layout: post
title: Semver for web apps is pointless
author: Greg Baker
date: 2025-10-20
categories: semver semantic-versioning
---

This might sound like heresy in some dev circles, but here goes: using semantic versioning for a web application is a
waste of time.

For years we've followed `MAJOR.MINOR.PATCH` as if it were scripture. And semver is a great system for what it was
built for. It's a contract between a library or API author and the developers who use it. The version number tells you
whether an update will break your code (`MAJOR`), add a feature without breaking anything (`MINOR`), or just fix a bug
(`PATCH`).

Your end users aren't developers calling your API, though. They're people using your app. And with a continuously
deployed web app, they're *always* on the latest version.

## What counts as a breaking change in a UI?

Semver is built around the idea of a breaking change. For an API that's easy to define. Rename an endpoint or remove a
required field and you've broken the contract, and client code fails.

Try applying that to a user interface. Say you move a button from the top right to the top left. Is that a breaking
change? For a user with muscle memory for where that button was, it definitely is. Say you tweak a shade of blue to
improve accessibility. For a color-blind user, that could be a big change. Meanwhile, a complete backend rewrite that
you'd call a `MAJOR` change might go completely unnoticed.

For someone using a web app, *any* UI change can be a breaking change. Semver's fixed categories don't map onto
something as fuzzy and personal as how a user experiences an interface.

## Your users don't care

Semver is a message for developers. Package managers and engineers read it to judge how risky an upgrade is. Even if you
show version numbers to your users, they have no idea what `2.5.1` versus `3.0.0` means.

Users also don't get to pick which version of a web app they run. They get whatever is deployed. So the whole message
semver sends is aimed at an audience that, for web apps, doesn't exist.

## What to use instead

Dropping semver doesn't mean dropping version numbers. It means picking a scheme that fits the job. Here are a few that
work much better for web apps.

**Calendar versioning (CalVer).** A version like `YYYY.MM.DD` or `YYYY.WW` (year and week number) means something to
everyone. Support, product managers, and even curious users can tell at a glance when a release went out. It's simple,
and it ties each version to a point in time.

**Build numbers or commit hashes.** If you deploy continuously, the most honest version is the git commit hash. It points
to the exact code running in production. For internal tracking, a build number from your CI/CD pipeline is often all you
need.

**A plain counter.** Just use a number that goes up by one with every release (`v45`, `v46`). It shows progress, it's
easy to understand, and it works well for internal QA and support.

Version numbers exist to communicate. For libraries and APIs, semver does that well: it signals breaking changes, new
features, and fixes. For user-facing, continuously deployed web apps, it turns into a ritual that sparks pointless
internal debates and gives users nothing. Pick a scheme that matches what's really happening, like a date, a build or
commit ID, or a simple release number, so your versions help your support and product teams instead of slowing them
down.
