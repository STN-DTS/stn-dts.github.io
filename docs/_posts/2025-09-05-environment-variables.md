---
layout: post
title: Environment variable management in a React Router v7 application
author: Greg Baker
date: 2025-09-05
categories: react-router environment-variables
---

Managing environment variables in a modern web application can be tricky. This post outlines a strategy for managing environment
variables in a React Router v7 project, covering both server-side and client-side concerns.

## Guiding Principles

A good environment variable strategy should be:

- **Type-Safe:** Use a library like `valibot` to catch errors early.
- **Secure:** Keep server-side and client-side variables separate to avoid exposing sensitive information.
- **Organized:** Group variables by domain (e.g., `authentication`, `redis`, `session`) to keep things tidy.
- **Centralized:** Access all variables through a single module for consistency.

## Server-Side Environment Variables

On the server, we can keep all our environment variable logic in an `app/.server/environment/` directory.

### Modular Structure

Inside this directory, we can create modules for each part of our application's configuration. For example,
`app/.server/environment/authentication.ts` can define all the environment variables related to authentication.

Each module exports a `valibot` schema that defines the shape of its environment variables, including their types, default
values, and any validation rules.

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

### Centralized Schema

The `app/.server/environment/server.ts` file imports all the modular schemas and combines them into a single `server` schema.
This gives us a complete picture of all the environment variables used by our application on the server.

### Loading and Parsing

The `app/.server/environment.ts` file is where everything comes together. It imports the `server` schema and uses it to parse
the `process.env` object. The parsed and validated environment variables are then exported as the `serverEnvironment` object.

This file also exports a `clientEnvironment` object, which is a subset of the `serverEnvironment` that's safe to expose to the
client.

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

The `preprocess` function transforms `process.env` by replacing empty strings with `undefined`. This is useful for handling
optional environment variables that may not be set.

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

### Security

To prevent sensitive information from being accidentally leaked, we can use a `Redacted` transform in our `valibot` schemas.
This transform wraps sensitive values in a special object that prevents them from being serialized to JSON. We use this for
values like `AZUREAD_CLIENT_SECRET` in the `authentication.ts` module.

## Client-Side Environment Variables

Client-side environment variables need to be handled with care to ensure that no sensitive information is exposed to the
browser.

### Defining Client-Safe Variables

The `app/.server/environment/client.ts` file defines a `valibot` schema for environment variables that are safe to expose to the
client. This schema only includes non-sensitive information, such as build details and feature flags.

### Exposing Variables via an API Endpoint

Instead of bundling client-side environment variables directly into the client-side code, we expose them via an API endpoint at
`/api/client-env`.

When the application loads, the `root.tsx` component renders a `<script>` tag that points to this endpoint.

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

The `v` query parameter is set to the `clientEnvRevision`, a hash of the client environment variables, for cache busting.

The `app/routes/api/client-env.ts` file handles requests to this endpoint. It returns a JavaScript file that creates a
`globalThis.__appEnvironment` object containing the client-side environment variables.

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

The response from the `/api/client-env` endpoint is aggressively cached by the browser. The `Cache-Control` header is set to
`max-age=31536000, immutable` (1 year) when the requested revision matches the current build revision. This ensures that the
client always has the correct environment variables without needing to re-fetch them on every page load.

## How to Add a New Environment Variable

### Server-Side Variable

1.  **Choose the right module:** Find the right module in `app/.server/environment/` for the new variable. If you can't find a
    good fit, create a new one.
2.  **Add to the schema:** Add the new variable to the `valibot` schema in the module you chose, specifying its type, default
    value, and any validation rules.
3.  **Add to defaults:** Add the default value to the `defaults` object in the same file.
4.  **Use the variable:** The new variable can now be accessed from the `serverEnvironment` object imported from
    `~/.server/environment`.

### Client-Side Variable

1.  **Add to the client schema:** Add the new variable to the `valibot` schema in `app/.server/environment/client.ts`.
2.  **Add to defaults:** Add the default value to the `defaults` object in the same file.
3.  **Use the variable:** The new variable will be automatically included in the `globalThis.__appEnvironment` object on the
    client side.

## Conclusion

This approach to environment variable management provides a solid foundation for building secure and maintainable applications.
By using `valibot` for schema validation and keeping a strict separation between server-side and client-side variables, you can
be confident that your application is configured correctly and securely.
