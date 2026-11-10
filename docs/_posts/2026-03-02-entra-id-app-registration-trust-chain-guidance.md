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

If your tenant is tightly locked down, setting up app registrations can feel like guessing a lock combination. You wire
up something that looks right, sign in, and hit a consent or permission error you didn't expect.

I've run into this again and again when connecting a frontend to a protected API in a tenant where users can't grant
delegated permissions (letting an app act on their behalf) unless the API has pre-authorized that client app. Add
tenant-wide admin approval for Microsoft Graph permissions on top of that, and even a basic sign-in can show warnings.

This post is practical advice for that kind of tenant. I describe the steps in the Azure Portal, but they're the same if
you automate with infrastructure as code (IaC).

## The trust chain

Most teams think of this as two apps: a frontend app and an API app.

In a restricted tenant there's a third piece you can't skip: a pre-authorization link from the API to the client.
Without it, the client can ask for scopes, but in practice users still can't grant it access.

Here's the mental model I use. Every piece has to be in place:

- The API app defines its scopes and app roles.
- The client app lists the API permissions it needs.
- The API app pre-authorizes that specific client for specific scopes.
- An admin grants consent wherever tenant policy requires it, for example for Microsoft Graph permissions.

If any one of these is missing, sign-in usually fails later on, and it looks like a bug in your code rather than a
configuration problem.

## Setting it up

Do things in this order. It saves a lot of trial and error.

### 1. Define the API first

Create the API app registration and publish the permissions it offers:

- Set the Application ID URI for the API.
- Define delegated scopes, with clear names and consent text.
- Define app roles if you need application permissions.
- Make sure the scope values are final before you wire up any clients.

The API comes first because every client's configuration depends on its scope IDs and values staying the same.

### 2. Register each client with its permissions spelled out

For each client app (for example, your frontend and your CLI):

- Add the API scopes it needs as required permissions.
- Add the Microsoft Graph permissions it needs.
- Set up redirect URIs and auth settings for that type of client.

Keep this boring and explicit. "We'll sort it out at consent time" is not a plan.

### 3. Pre-authorize clients on the API

This is the step people forget in restricted tenants. For each client that calls the API:

- Open the API app registration.
- Add the client app as an authorized client.
- Select the API scopes that client is allowed to request.

If your tenant blocks user delegation without pre-authorization, this is the step that turns a setup that "looks right"
into one that actually works.

### 4. Get admin consent on purpose

In many organizations, Microsoft Graph permissions need admin approval, even delegated ones. So expect consent warnings
at sign-in until an administrator grants consent for the Graph scopes you request.

Plan this as its own step. Don't leave it as an afterthought.

## Tenant quirks to expect

### Delegated permissions fail without pre-authorization

You'll see this when sign-in works but calls to the API fail with consent or "insufficient privileges" errors.

Usually the client asked for a valid API scope, but the API app hasn't pre-authorized that client. To fix it, add the
client as a pre-authorized client in the API app registration, then double-check that the exact scopes the client
requests are selected.

### Graph delegated permissions still need admin approval

You'll see warnings or admin approval prompts at sign-in, even for basic sign-in scopes.

This happens because tenant policy requires admin consent for Microsoft Graph permissions. Have an admin grant consent
for the Graph permissions the client requests. Keep your list of Graph scopes short so it's easy for them to review.

### Scope names match, but IDs differ between environments

Non-prod works, but another environment fails with what looks like a consent mismatch.

Usually the client is pointed at the wrong API registration, or it's using scope IDs copied from somewhere else. Check
the API app ID, the client app ID, and the target scopes in each environment. Then set up the pre-authorization link
again for the right client and API pair.

## Quick troubleshooting table

| Symptom | Most likely cause | Where to fix |
|---|---|---|
| User can sign in but API call returns insufficient privileges | Client is not pre-authorized on API | API app registration -> Authorized client applications |
| Consent prompt keeps appearing for Graph scopes | Admin consent not granted per tenant policy | Entra admin consent workflow for Graph permissions |
| Azure Portal frontend works but Swagger UI fails (or vice versa) | One client app was configured, the other was not | Compare required permissions and pre-authorization per client |
| Everything looks configured but still fails in one env | IDs or scopes copied from another environment | Re-validate app IDs, scope values, and consent in that environment |

## Habits that help

A few team habits make this a lot less painful. Treat API scopes as a contract and be careful when you change them. Keep
a short checklist for every new client app. Make pre-authorization a required item in reviews. And talk to your tenant
admins early about Graph consent.

None of these steps is hard on its own. The pain comes from missing one link in the chain and only finding out at
sign-in.

## Wrapping up

In a tenant with strict consent policy, setting up app registrations is less about flipping the right switches and more
about building a complete trust chain.

Define the API scopes first. Give each client its permissions explicitly. Pre-authorize clients on the API. Plan for
Graph admin consent from day one. Do it in that order and most of the guesswork goes away, and developers get a setup
that behaves the same way every time.
