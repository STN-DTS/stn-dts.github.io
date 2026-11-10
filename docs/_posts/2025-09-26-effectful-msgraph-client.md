---
layout: post
title: Creating an MSGraph client using Effect-TS
author: Greg Baker
date: 2025-09-26
categories: effect-ts msgraph typescript
---

Calling an external API sounds simple until you have to deal with network failures, responses that don't look like you
expected, and a pile of async code. The Microsoft Graph API (MSGraph) is no different. It has its own rules too, like
limits on how many operations you can batch together and a specific way to authenticate.

We used Effect-TS to manage this. Effect is a TypeScript library that replaces promises and `async/await` with its own
type called an `Effect`. An `Effect` is a description of some work, like an API call, that hasn't run yet. Because it's
just a value, you can combine it with other effects, test it, and see in its type exactly what it returns and how it can
fail.

In this post I'll walk through a small MSGraph client built with Effect. It covers authentication, checking the shape of
API responses, and batching, which is the trickiest part.

## Schemas and errors

Before making any API calls, we define what data we expect back and what our errors look like.

### Defining data with `effect/Schema`

Effect's `Schema` module lets us describe the shape of our data and then parse and validate against it. If an API
response doesn't match the schema, the operation fails right there, so bad data never makes it into the rest of the
app.

Here's a schema for an MSGraph user. We only need a few fields.

```typescript
// src/msgraph/schemas.ts
import { Schema } from 'effect';

export const MSGraphUser = Schema.Struct({
  '@odata.type': Schema.String,
  'id': Schema.String,
  'displayName': Schema.String,
});

export type MSGraphUser = Schema.Schema.Type<typeof MSGraphUser>;
```

The Graph API returns a lot of its lists in pages, so we also need a schema for a paginated response. Since the items
in the page can be anything, we write a function that builds the schema for us:

```typescript
// src/msgraph/schemas.ts
export const PagedResponse = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    '@odata.nextLink': Schema.optional(Schema.String),
    'value': Schema.Array(schema),
  });
```

`PagedResponse` takes a schema for one item and returns a schema for a page of those items. We'll use it in a moment.

### A custom error type

Instead of throwing generic errors, we give the client its own error type. Effect's `Data.TaggedError` makes this
easy.

```typescript
// src/msgraph/errors.ts
import { Data } from 'effect';

export class MSGraphError extends Data.TaggedError('@support/MSGraphError')<{
  readonly error: unknown;
  readonly message?: string;
}> {}
```

A tagged error carries a label (the "tag", here `@support/MSGraphError`). Effect can match on that tag, so callers can
handle this specific failure without catching everything else by accident.

## Building the client

Now we can write the client functions. Each one returns an `Effect` that describes a call to the MSGraph API.

### Authentication

First we need an access token. We use the OAuth client credentials flow, which is the one meant for an app talking to
an API on its own, with no user signing in. We send a `POST` request with the app's credentials to the Microsoft
identity platform and get a token back.

```typescript
// src/msgraph/client.ts
import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform';
import { Effect } from 'effect';
import { MSGraphError } from '~/msgraph/errors';
import { AccessTokenResponse } from '~/msgraph/schemas';

export const authenticate = (
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: scope,
        grant_type: 'client_credentials',
      }),
    );

    return yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessTokenResponse)),
      Effect.map((response) => response.access_token),
    );
  }).pipe(
    Effect.mapError((error) => new MSGraphError({ message: 'Failed to authenticate', error: error })),
  );
```

`Effect.gen` lets us write this with generator functions (`function*` and `yield*`), which reads a lot like
`async/await`. Here's what happens, step by step:

1. We get the default `HttpClient` from the Effect context. The context is where Effect keeps dependencies like this,
   so we don't have to pass them around by hand.
1. We build a `POST` request. `HttpClientRequest.bodyUrlParams` formats the body the way the token endpoint expects.
1. We `execute` the request and pipe the result through a few steps.
1. `filterStatusOk` makes the effect fail if the HTTP status isn't in the 200-299 range.
1. `schemaBodyJson(AccessTokenResponse)` parses the JSON body with the `AccessTokenResponse` schema. This is where the
   validation happens.
1. `map` pulls the `access_token` out of the parsed response.
1. `mapError` wraps any failure in our `MSGraphError`, with a message that says what we were trying to do.

### Fetching group members

With a token in hand, we can fetch the members of a group. The Graph API has endpoints for direct members and for
transitive (nested) members. The code is nearly the same for both, so here's the direct one.

```typescript
// src/msgraph/client.ts
export const getDirectGroupMembers = (authToken: string, groupId: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const url = `https://graph.microsoft.com/v1.0/groups/${groupId}/members?$top=999`;

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.bearerToken(authToken)
    );

    return yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PagedResponse(MSGraphUser))),
      Effect.map(({ value }) => value.filter((member) => member['@odata.type'] === '#microsoft.graph.user')),
    );
  }).pipe(
    Effect.mapError((error) => new MSGraphError({ message: `Failed to fetch members for group ${groupId}`, error: error })),
  );
```

We parse the list of members with `PagedResponse(MSGraphUser)`. Then we filter it so we only return users, because a
group can also contain things like devices or service principals (app identities).

#### What about pagination?

To keep things simple, this function asks for a single large page with `$top=999`. That means it's incomplete for
groups with more than 999 members. A production client would check the response for `@odata.nextLink` and keep fetching
until there are no more pages. Effect has tools like `Effect.iterate` that would handle this nicely, but we left it out
here.

### Changing group membership in bulk

Adding or removing hundreds of users one at a time is slow. It's better to batch the work, and there are two common ways
to do it: send several requests in parallel, or use the JSON batching endpoint. We use one for each.

#### Adding members with parallel requests

To add members, we send a `PATCH` request with the `members@odata.bind` property. The API lets you add up to 20 members
in one request, so we split the user list into chunks of 20 and send all the requests in parallel.

```typescript
// src/msgraph/client.ts
import { Chunk, Effect } from 'effect';

const MAX_REQUESTS_PER_BATCH = 20;

export const addMembersToGroup = (authToken: string, groupId: string, users: MSGraphUser[]) =>
  Effect.gen(function* () {
    // ... setup httpClient and url

    const userChunks = Chunk.chunksOf(Chunk.fromIterable(users), MAX_REQUESTS_PER_BATCH);

    const effects = userChunks.pipe(
      Chunk.map((userChunk) => {
        const request = HttpClientRequest.patch(url).pipe(
          HttpClientRequest.bearerToken(authToken),
          HttpClientRequest.bodyUnsafeJson({
            'members@odata.bind': Chunk.toArray(userChunk).map(user => `https://graph.microsoft.com/v1.0/directoryObjects/${user.id}`)
          }),
        );
        return httpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk)
        );
      })
    );

    yield* Effect.all(effects, { concurrency: 'inherit' });
  }).pipe(
    Effect.mapError((error) => new MSGraphError({ message: `Failed to add members to group`, error: error })),
  );
```

`Chunk` is one of Effect's immutable data structures, and `Chunk.chunksOf` splits the users into groups of 20. We turn
each group into an `Effect` that makes the API call. `Effect.all` then runs them all concurrently and waits for every
one to succeed. If any single request fails, the whole operation fails.

#### Removing members with JSON batching

To remove members, we use the `$batch` endpoint. It lets us bundle up to 20 separate `DELETE` operations into one
`POST` request, which is the most efficient way to do a lot of deletions.

The tricky part is the response. The batch request itself can come back `200 OK` even when some of the operations
*inside* it failed. So we have to look at the response body to know whether everything actually worked.

```typescript
// src/msgraph/client.ts
export const removeMembersFromGroup = (authToken: string, groupId: string, users: MSGraphUser[]) =>
  Effect.gen(function* () {
    // ... setup httpClient and url

    const requests = users.map((user) => ({
      id: user.id,
      method: 'DELETE',
      url: `/groups/${groupId}/members/${user.id}/$ref`,
    }));

    const requestChunks = Chunk.chunksOf(Chunk.fromIterable(requests), MAX_REQUESTS_PER_BATCH);

    const effects = requestChunks.pipe(
      Chunk.map((requestChunk) => {
        const request = HttpClientRequest.post('https://graph.microsoft.com/v1.0/$batch').pipe(
          HttpClientRequest.bearerToken(authToken),
          HttpClientRequest.bodyUnsafeJson({ requests: Chunk.toArray(requestChunk) }),
        );

        return httpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(BatchResponse)),
          Effect.flatMap(({ responses }) => {
            const failures = responses.filter((response) => response.status >= 400);
            return failures.length === 0 ? Effect.void : Effect.fail(failures);
          }),
        );
      })
    );

    yield* Effect.all(effects, { concurrency: 'inherit' });
  }).pipe(
    Effect.mapError((error) => new MSGraphError({ message: 'Failed to remove members from group', error: error })),
  );
```

This is the most involved function, and it's where Effect earns its keep. The important bit is the last `flatMap`,
after we parse the batch response. It checks whether any of the inner responses has an error status (400 or higher).
If one does, we fail the effect on purpose with `Effect.fail`. If not, we succeed with `Effect.void`. So if
`removeMembersFromGroup` succeeds, we know every user was actually removed.

## Wrapping up

That's a small MSGraph client. With Effect, the async calls, response validation, and error handling are all split into
small pieces that fit together, and the types tell you what each piece returns and how it can fail.

Effect does take some getting used to. Thinking in effects instead of promises is a real shift. But for code with a lot
of async work, like this client, we think it's worth it. The code is easier to reason about, handles failure better,
and is easier to maintain. That's especially true for the hard parts, like batching and error handling.
