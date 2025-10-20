---
layout: post
title: Semver for web apps is pointless
author: Greg Baker
date: 2025-10-20
categories: semver semantic-versioning
---

I'm going to say something that might sound like heresy in some dev circles:
using semantic versioning for a web application is a waste of time.

For years, we've been dutifully following the `MAJOR.MINOR.PATCH` scripture as
if it were handed down from on high. No doubt it's a great system... for its
intended purpose. Semver is a contract, a clear signal from a library or API
author to the developers consuming it. It tells you if an update will break your
code (`MAJOR`), add a feature without breaking anything (`MINOR`), or fix a bug
(`PATCH`).

But here's the thing: your end-users aren't developers consuming your API. They
are people trying to use your application, and in the world of continuously
deployed web apps, they are *always* on the latest version.

### What is a "*breaking change*" in a UI anyway?

The core concept of semver hinges on the idea of a "breaking change." For an
API, that's straightforward: you rename an endpoint, remove a required field,
and boom... you've broken the contract. Client code will fail.

Now, try to apply that to a user interface. You move a button from the top right
to the top left. Is that a breaking change? For a user who has built muscle
memory around that button's location, you bet it is. You change a shade of blue
in your color palette for better accessibility. To a color-blind user, that
could be a massive breaking change. To another user, a complete backend overhaul
that you might consider a `MAJOR` change is completely unnoticeable.

The reality is, for a user of a web application, *any* UI change can be a
"breaking change." The rigid categories of semver simply don't map to the fluid,
subjective experience of a user interface.

### Your audience doesn't care

Semver is a message for developers. It's designed to be read by package managers
and engineers to understand the impact of an upgrade. Even if you make your
version numbers visible to your users, they have no idea what `2.5.1` vs `3.0.0`
means.

We don't give users a choice about which version of a web app they use. They get
what's deployed. The whole communication system that semver provides is aimed at
an audience that, for web apps, doesn't exist.

### So, is there a better way?

Ditching semver doesn't mean ditching versioning altogether. It just means
picking a tool that's right for the job. Here are a few far more practical
alternatives for web applications:

* **Calendar versioning (CalVer)**: Using a version like `YYYY.MM.DD` or
  `YYYY.WW` (week number) is instantly meaningful to everyone. Support teams,
  product managers, and even curious users can immediately tell when a version
  was released. It's simple, intuitive, and ties the software directly to the
  passage of time.
* **Build numbers & commit hashes**: In a continuous deployment environment,
  the most truthful version is the git commit hash. It's a unique pointer to
  the exact code running in production. For internal tracking, associating a
  build number from your CI/CD pipeline is often more than enough.
* **Simple, sequential versioning**: Just use an integer that goes up with
  every release (`v45`, `v46`)! It's straightforward, communicates
  progression, and is perfect for internal QA and support processes.

Version numbers exist to communicate. For libraries and APIs, semver does that
reliably: it signals breaking changes, new features, and fixes. But in
user‑facing, continuously deployed web apps, semver becomes a ritual that
invites needless internal debate and provides little value to actual users.
Instead, favour schemes that map to reality (ex: a calendar date, a build/commit
id, or a simple sequential release number) so your versions help support and
product teams, not slow them down.
