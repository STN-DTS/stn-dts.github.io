---
layout: post
title: Creating an MSGraph client using Effect-TS
author: Greg Baker
date: 2025-09-26
categories: effect-ts msgraph
---

Interacting with external APIs is a cornerstone of modern software development.
But it's often a messy affair, filled with the perils of network failures,
unexpected payloads, and complex asynchronous logic. The Microsoft Graph API,
while incredibly powerful, is no exception. It has its own set of rules, like
batching limits and specific authentication flows.

This is where Effect-TS comes in. Effect is a TypeScript library for building
robust, type-safe, and composable applications. It replaces promises and
`async/await` with a powerful new abstraction -- the `Effect` -- that turns side
effects, like API calls, into first-class, testable values.

In this post, we'll walk through creating a simple, yet powerful, client for the
MSGraph API using Effect-TS. We'll tackle authentication, data validation, and
even the tricky business of batch processing, showing how Effect helps us manage
complexity and write code that is both resilient and easy to understand.

## The foundation: schemas and errors

Before we make our first API call, let's define the shape of the data we expect
to receive and how we'll handle errors. This upfront investment in data modeling
is a core tenet of writing reliable software.

### Defining data structures with `effect/Schema`

Effect's `Schema` module allows us to define parsers and validators for our data
structures. If an API response doesn't match the schema we define, the operation
will fail, preventing malformed data from propagating through our system.

First, let's define a schema for a Microsoft Graph User. We only care about a
few fields for our purposes.

``` typescript
// src/msgraph/schemas.ts
import { Schema } from 'effect';

export const MSGraphUser = Schema.Struct({
  '@odata.type': Schema.String,
  'id': Schema.String,
  'displayName': Schema.String,
});

export type MSGraphUser = Schema.Schema.Type<typeof MSGraphUser>;
```

Next, we need a way to parse paginated responses, which are common in the Graph
API. We can create a generic schema factory for this:

``` typescript
// src/msgraph/schemas.ts
export const PagedResponse = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    '@odata.nextLink': Schema.optional(Schema.String),
    'value': Schema.Array(schema),
  });
```

This `PagedResponse` function takes another schema as input and produces a new
schema for a paginated list of that type. We'll see it in action shortly.

### A custom error for our domain

Instead of throwing generic errors, we can create a custom, structured error
type for our client. Effect's `Data.TaggedError` makes this trivial.

``` typescript
// src/msgraph/errors.ts
import { Data } from 'effect';

export class MSGraphError extends Data.TaggedError('@support/MSGraphError')<{
  readonly error: unknown;
  readonly message?: string;
}> {}
```

By creating a tagged error, we can use Effect's powerful pattern matching
capabilities to handle specific failures in our logic, making our error handling
more precise and robust.

## Building the client

With our schemas and errors defined, we can start building the client functions.
Each function will return an `Effect` that describes an interaction with the
MSGraph API.

### Authentication

First, we need to get an access token. We'll use the OAuth client credentials
flow. This involves sending a `POST` request with our application's credentials
to the Microsoft identity platform.

``` typescript
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

Let's break this down. We use `Effect.gen` to write our logic in a clean,
generator-based style that resembles `async/await`.

1. We get the default `HttpClient` from the Effect context.
1. We construct a `POST` request, using `HttpClientRequest.bodyUrlParams` to
   correctly format the request body.
1. We `execute` the request and then pipe the result through a series of
   transformations.
1. `filterStatusOk` ensures the effect will fail if the HTTP response status is
   not in the 200-299 range.
1. `schemaBodyJson(AccessTokenResponse)` attempts to parse the JSON response
   body using the `AccessTokenResponse` schema we defined earlier. This is
   where validation happens.
1. `map` extracts the `access_token` from the parsed response.
1. Finally, `mapError` wraps any potential failure in our custom
   `MSGraphError`, providing clear, contextual error information.

### Fetching group members

Now that we can authenticate, let's fetch the members of a group. The Graph API
provides endpoints for getting both direct and transitive (nested) members. The
logic is nearly identical for both.

``` typescript
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

Here, we use our generic `PagedResponse(MSGraphUser)` schema to parse the list
of members. We then filter the result to ensure we only return actual user
objects, as a group can also contain other entities like devices or service
principals.

#### A note on tradeoffs: pagination

A key consideration when working with real-world APIs is handling pagination.
For simplicity, this function uses the `$top=999` query parameter to fetch a
large page of results. However, for groups with more than 999 members, this
implementation is incomplete. A production-ready client would need to check for
the `@odata.nextLink` property in the response and recursively fetch all pages.
Effect provides powerful tools like `Effect.iterate` that could handle this
elegantly, but it's a complexity we've chosen to omit here.

### Modifying group membership in bulk

The Graph API can be slow if you try to add or remove hundreds of users one by
one. The correct approach is to batch operations. There are two common ways to
do this: parallel requests and the JSON batching endpoint.

#### Adding members with parallel requests

To add members, we can use the `members@odata.bind` property in a `PATCH`
request. The API allows up to 20 members to be added in a single request. We can
split our user list into chunks of 20 and send all the requests in parallel.

``` typescript
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

Here, we use `Chunk.chunksOf` from Effect's immutable data structures to split
the users. Then, we map each chunk to an `Effect` that performs the API call.
Finally, `Effect.all` runs all of these effects concurrently and waits for them
all to complete successfully. If any single request fails, the entire operation
fails.

#### Removing members with JSON batching

For removing members, we'll use the `$batch` endpoint. This allows us to package
up to 20 individual `DELETE` operations into a single `POST` request. This is
the most efficient way to perform a large number of deletions.

Handling the response from the `$batch` endpoint is tricky. The main request can
succeed with a `200 OK` status, but individual operations *within* the batch can
fail. We must inspect the body of the response to know if the entire operation
was a success.

``` typescript
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

This is the most complex function, but it showcases Effect's power. After
parsing the batch response, we have a crucial `flatMap`. We check if any of the
inner responses have a failure status code. If they do, we explicitly fail the
`Effect` with `Effect.fail`. If not, we succeed with `Effect.void`. This gives
us a guarantee that if the `removeMembersFromGroup` effect succeeds, all users
were removed successfully.

## Conclusion

We've built a small but powerful MSGraph client. By leveraging Effect-TS, we've
created code that is not only functional but also robust, type-safe, and
declarative. We've turned complex asynchronous operations, data validation, and
error handling into manageable, composable pieces.

There is certainly a learning curve to Effect-TS. Thinking in terms of effects
rather than promises requires a mental shift. However, as we've seen, the payoff
is significant. For applications with complex asynchronous workflows, like our
MSGraph client, Effect provides a solid foundation for building software that is
easier to reason about, more resilient to failure, and ultimately more
maintainable. The safety and clarity it brings to challenging topics like
batching and error handling are well worth the investment.
