---
layout: post
title: "Entra ID app registration guidance for locked-down tenants"
date: 2026-03-02
author: Greg Baker
categories:
- entra-id
- azure
- app-registration
- authentication
- oauth2
---

If your tenant is tightly governed, setting up app registrations can feel like
trying combinations on a lock. You wire up what looks correct, sign in, and get
a consent or permission error you did not expect.

I have run into this repeatedly when connecting a frontend to a protected API in
a tenant where delegated permissions are not allowed unless the client is
pre-authorized by the API. Add tenant-wide admin approval requirements for
Microsoft Graph, and even basic sign-in flows can produce warnings.

This post is practical guidance for that environment. It is written for the
Azure Portal, but it works the same if you automate with IaC.

## The trust chain you actually need

Most teams think in terms of two apps:

1. Frontend app
2. API app

In restricted tenants, there is usually a third piece you cannot skip:

3. A pre-authorization link from API to client

Without that link, the client can request scopes, but users still cannot
delegate access in practice.

A reliable mental model is:

- The API app defines scopes and app roles
- The client app declares required permissions to that API
- The API app pre-authorizes that specific client app for specific scopes
- An admin grants consent where tenant policy requires it (for example, when
  making calls to MS Graph APIs)

If any one of those is missing, the login flow usually fails later and looks
like a runtime bug.

## Setup patterns that work

Use this order. It saves a lot of trial and error.

### Pattern 1: define the API contract first

Create the API app registration and publish the permissions it offers.

Checklist:

- Set the Application ID URI for the API
- Define delegated scopes with clear names and consent display text
- Define app roles if you need application permissions
- Confirm the scope values are final before wiring clients

Why first? Because every client configuration depends on stable scope IDs and
scope values.

### Pattern 2: register each client with explicit required permissions

For each client app (for example, your frontend and your CLI):

- Add required API permissions to the target API scopes
- Add required Microsoft Graph permissions
- Configure redirect URIs and auth settings for that client type

Keep this boring and explicit. Do not rely on "we will fix it in consent later"
as a strategy.

### Pattern 3: pre-authorize clients on the API app

This is the step that is often forgotten in restricted tenants.

For each client that calls the API:

- Open the API app registration
- Add the client app as an authorized client
- Select the API scopes that client is allowed to request

If your tenant blocks user delegation unless pre-authorization exists, this is
what turns a configuration that "looks right" into one that actually works.

### Pattern 4: complete admin consent intentionally

In many organizations, Microsoft Graph permissions require admin approval,
including delegated permissions.

That means you should expect consent warnings during sign-in until an
administrator grants consent for the requested Graph scopes.

Do this as an explicit operational step, not as an afterthought.

## Tenant quirks you should expect

### Quirk 1: delegated permissions fail without API pre-authorization

Symptom:

- User sign-in succeeds, but API access fails with consent or insufficient
  privileges style errors

Typical root cause:

- Client requested a valid API scope, but the API app has not pre-authorized
  that client

Fix:

- Add client pre-authorization in the API app registration
- Re-check that the exact scopes requested by the client are selected

### Quirk 2: Graph delegated permissions still need admin approval

Symptom:

- Login shows warnings or admin approval prompts even for basic sign-in scopes

Typical root cause:

- Tenant policy requires administrator consent for Microsoft Graph permissions

Fix:

- Have an admin grant consent for Graph permissions requested by the client
- Keep your Graph scope request minimal so approvals are easier to review

### Quirk 3: scope names are correct, but IDs drift between environments

Symptom:

- Nonprod works, another environment fails with consent mismatch behavior

Typical root cause:

- Client is wired to the wrong API registration or stale scope identifiers

Fix:

- Verify the API app ID, client app ID, and target scopes per environment
- Re-apply the pre-authorization link for the correct client and API pair

## Fast troubleshooting matrix

| Symptom | Most likely cause | Where to fix |
|---|---|---|
| User can sign in but API call returns insufficient privileges | Client is not pre-authorized on API | API app registration -> Authorized client applications |
| Consent prompt keeps appearing for Graph scopes | Admin consent not granted per tenant policy | Entra admin consent workflow for Graph permissions |
| Azure Portal frontend works but Swagger UI fails (or vice versa) | One client app was configured, the other was not | Compare required permissions and pre-authorization per client |
| Everything looks configured but still fails in one env | IDs or scopes copied from another environment | Re-validate app IDs, scope values, and consent in that environment |

## Practical guardrails for teams

A few habits make this easier:

- Treat API scopes as a contract and version changes carefully
- Keep a short checklist for every new client app
- Make pre-authorization a required review item
- Involve tenant admins early for Graph consent requirements

None of this is complicated on its own. The pain comes from missing one link in
the chain and discovering it only at sign-in time.

## Conclusion

If your tenant enforces strict consent policy, app registration setup is less
about toggling options and more about building a complete trust chain.

Define API scopes first, wire client permissions explicitly, pre-authorize
clients on the API, and plan for admin consent on Graph from day one. That
sequence removes most of the guesswork and gives developers a setup that works
predictably.
