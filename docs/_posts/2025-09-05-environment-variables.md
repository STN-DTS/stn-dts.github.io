---
layout: post
title: Environment variable management in a React Router v7 application
author: Greg Baker
date: 2025-09-05
categories: react-router environment-variables
---

Environment variables look simple until your app has a server and a browser side and a dozen settings to juggle. This
post walks through how we manage them in a React Router v7 project, on both the server and the client.

## What we want

We had four goals for our setup.

It should be type-safe. We validate everything with a library called `valibot`, so a missing or malformed variable
fails fast at startup instead of somewhere deep in a request.

It should keep secrets on the server. Server-side and client-side variables are kept separate so nothing sensitive ends
up in the browser.

It should be organized. Variables are grouped by area, like `authentication`, `redis`, or `session`.

It should have one entry point. All code reads variables through a single module, so there's one way to do it.

## Server-side variables

On the server, all the environment variable code lives in an `app/.server/environment/` directory.

### One module per area

Inside that directory there's a module for each part of the app's configuration. For example,
`app/.server/environment/authentication.ts` holds everything related to authentication.

Each module exports a `valibot` schema. The schema describes that area's variables: their types, their default values,
and any validation rules.

Here's what `app/.server/environment/authentication.ts` might look like:

```typescript
import * as v from 'valibot';
import { Redacted } from '~/.server/utils/security-utils';

export type Authentication = Readonly<v.InferOutput<typeof authentication>>;

const isProduction = process.env.NODE_ENV === 'production';

export const defaults = {
  AUTH_DEFAULT_PROVIDER: isProduction ? 'azuread' : 'local',
  AUTH_SCOPES: 'openid profile email',
} as const;

export const authentication = v.object({
  AUTH_DEFAULT_PROVIDER: v.optional(v.picklist(['azuread', 'local']), defaults.AUTH_DEFAULT_PROVIDER),
  AUTH_SCOPES: v.optional(v.string(), defaults.AUTH_SCOPES),
  AZUREAD_ISSUER_URL: v.optional(v.string()),
  AZUREAD_CLIENT_ID: v.optional(v.string()),
  AZUREAD_CLIENT_SECRET: v.optional(v.pipe(v.string(), v.transform(Redacted.make))),
});
```

### Combining the schemas

`app/.server/environment/server.ts` imports all of those module schemas and combines them into one `server` schema. That
gives us a single place to see every environment variable the server uses.

### Loading and parsing

`app/.server/environment.ts` is where it all comes together. It parses `process.env` against the `server` schema and
exports the validated result as `serverEnvironment`.

It also exports `clientEnvironment`, which holds only the values that are safe to send to the browser. Each object gets
a `revision`, which is an MD5 hash of its contents. We'll use the client one later for caching.

```typescript
import { createHash } from 'node:crypto';
import * as v from 'valibot';

import type { Client } from '~/.server/environment/client';
import { client } from '~/.server/environment/client';
import type { Server } from '~/.server/environment/server';
import { server } from '~/.server/environment/server';
import { preprocess } from '~/utils/validation-utils';

export type ClientEnvironment = Client;
export type ServerEnvironment = Server;

const processed = preprocess(process.env);
const isProduction = processed.NODE_ENV === 'production';

const parsedClientEnvironment = v.parse(client, { ...processed, isProduction });
const parsedServerEnvironment = v.parse(server, { ...processed, isProduction });

export const clientEnvironment: ClientEnvironment & { revision: string } = {
  ...parsedClientEnvironment,
  revision: createHash('md5')
    .update(JSON.stringify(parsedClientEnvironment))
    .digest('hex'),
};

export const serverEnvironment: ServerEnvironment & { revision: string } = {
  ...parsedServerEnvironment,
  revision: createHash('md5')
    .update(JSON.stringify(parsedServerEnvironment))
    .digest('hex'),
};
```

Before parsing, `preprocess` goes through `process.env` and turns empty strings into `undefined`. That matters for
optional variables. If someone sets `AUTH_SCOPES=` with nothing after it, we want the schema to treat it as "not set" and
fall back to the default, not as an empty string.

```typescript
/**
 * Preprocesses validation input.
 *
 * This function takes a record and returns a new record with empty string
 * values replaced with undefined. This is useful for handling optional
 * environment variables that may not be set.
 *
 * @param data - The record to be preprocessed.
 * @returns A new record with empty string values replaced with undefined.
 */
export function preprocess<K extends string | number | symbol, T>(data: Record<K, T>): Record<K, T | undefined> {
  const processedEntries = Object.entries(data) //
    .map(([key, val]) => [key, val === '' ? undefined : val]);

  return Object.fromEntries(processedEntries);
}
```

### Keeping secrets out of logs

Secrets can leak by accident, for example when someone logs the whole config object. To guard against that, we run
sensitive values through a `Redacted` transform in the `valibot` schema. It wraps the value in a special object that
won't serialize to JSON. You can see it on `AZUREAD_CLIENT_SECRET` in `authentication.ts` above.

## Client-side variables

Anything the browser can see, users can see too. So we're careful about what goes to the client.

### Deciding what's safe

`app/.server/environment/client.ts` defines a separate `valibot` schema for variables that are safe to expose. It only
contains non-sensitive things like build details and feature flags.

### Serving them from an endpoint

We don't bake client variables into the JavaScript bundle. Instead, we serve them from an API endpoint at
`/api/client-env`.

`root.tsx` renders a `<script>` tag that points at that endpoint, so the variables load with the page:

```tsx
// app/root.tsx
export default function App({ loaderData }: Route.ComponentProps) {
  const { currentLanguage } = useLanguage();

  return (
    <html lang={currentLanguage}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script
          nonce={loaderData.nonce}
          src={`/api/client-env?v=${loaderData.clientEnvRevision}`}
          suppressHydrationWarning={true}
        />
      </head>
      {/* ... */}
    </html>
  );
}
```

The `v` query parameter is `clientEnvRevision`, the hash of the client variables. When the variables change, the hash
changes, so the URL changes too. That's how we bust the browser cache.

`app/routes/api/client-env.ts` handles the request. It returns a small JavaScript file that sets
`globalThis.__appEnvironment` to the client variables.

```typescript
// app/routes/api/client-env.ts
import type { Route } from './+types/client-env';
import { clientEnvironment, serverDefaults } from '~/.server/environment';

const CACHE_DURATION_SECS = 365 * 24 * 60 * 60; // 1 year

export function loader({ request }: Route.LoaderArgs) {
  const revision = new URL(request.url).searchParams.get('v') ?? serverDefaults.BUILD_REVISION;

  const shouldCache = revision !== serverDefaults.BUILD_REVISION;

  return new Response(`globalThis.__appEnvironment = ${JSON.stringify(clientEnvironment)}`, {
    headers: {
      'Content-Type': 'application/javascript',
      ...(shouldCache
        ? { 'Cache-Control': `max-age=${CACHE_DURATION_SECS}, immutable` }
        : { 'Cache-Control': 'no-cache' }),
    },
  });
}
```

### Caching

The browser caches the `/api/client-env` response hard. When the request has a revision in `v`, the response gets
`Cache-Control: max-age=31536000, immutable`, which means one year. If `v` is missing, or is just the default
`BUILD_REVISION`, the response is sent with `no-cache` instead.

Caching for a year is safe here because the URL includes the hash. If the variables change, the page asks for a new URL
and the browser fetches it fresh. If they don't change, the browser never has to download them again.

## Adding a new variable

### On the server

1. Pick the module in `app/.server/environment/` that fits the new variable. If none of them fit, create a new one.
2. Add the variable to that module's `valibot` schema, with its type, default value, and any validation rules.
3. Add its default value to the `defaults` object in the same file.
4. Use it. It's now available on the `serverEnvironment` object you import from `~/.server/environment`.

### On the client

1. Add the variable to the `valibot` schema in `app/.server/environment/client.ts`.
2. Add its default value to the `defaults` object in the same file.
3. Use it. It's automatically included in `globalThis.__appEnvironment` in the browser.

## Wrapping up

This setup gives us a solid base for secure, maintainable apps. Validating with `valibot` and keeping server
and client variables strictly apart means we can trust that the app is configured correctly, and that secrets stay on
the server.
