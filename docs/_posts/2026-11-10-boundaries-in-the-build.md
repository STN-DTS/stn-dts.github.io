---
layout: post
title: "Boundaries in the Build: A Modular Monolith with Effect and React Router 8"
date: 2026-11-10
author: Greg Baker
categories:
- architecture
- domain-driven-design
- effect-ts
- react-router
- typescript
---

I wanted several teams to work on one citizen-facing web application without stepping on each other. Each team owns
one area: sign-in, the citizen's profile, benefits, jobs, payments, and a dashboard that ties them together. I also
wanted one build, one server process and one container image.

The usual way to keep teams apart is to put a network between them, with separate services, separate deployables and
contracts checked at run time. This time I moved the boundaries into the build instead. Each area is a package. The
compiler and a small lint script decide what each package may touch. Effect wires the pieces together on the server,
and React Router 8 renders the pages.

This post walks through how that works. To keep it concrete, I'll follow one request the whole way: a signed-in citizen
opens `/en/jobs` to see job postings that match their experience.

One trade-off up front, so it doesn't feel hidden later: every team ships on the same release train. If a team truly
needs to deploy on its own schedule, this design doesn't give them that. In exchange you get no version skew between
pages, no composition layer to run, one developer experience, and contracts the compiler checks.

## The shape: one app, many packages

The repository has two kinds of workspace: one application and many packages.

![The app at the top wires in every package; modules in the middle each publish a small API; ui and the kernel sit at the bottom]({{ '/assets/images/2026-11-10-modular-monolith/repo-map.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

```
apps/web/                  the application: one build, one process, one image
  server.ts                process entry
  server/runtime.ts        composition root: every module's Effect layer
  server/http/             the Effect HTTP server
  app/routes.ts            React Router's route config, built from the modules
  app/register.ts          types the kernel with the real app (more on this later)
  app/routes/layouts/      three layouts; the language page and the 404
packages/
  kernel/                  shared kernel: the Effect ↔ React Router bridge, request scope, module contract
  ui/                      the design system
  identity/                sign-in, sign-out, the session, page guards
  profile/                 the citizen's record, contact details, consent
  benefits/                the program catalogue and the benefits finder
  jobs/                    job postings matched to the citizen, and their shortlist
  dashboard/               the account's home page
  …                        payments, employment records, and a few more
```

The application is the **composition root**. It owns almost nothing: the process entry, the HTTP server, three layouts,
the 404 page, and the wiring that pulls every module in. There's no business logic in it at all.

Each package under `packages/` is one **bounded context**, owned by one team. The `kernel` is the shared kernel in the
DDD sense: a small, slow-moving set of types and helpers every module agrees on. It depends on no other workspace
package. `ui` is the design system, and it depends only on the kernel.

One detail surprised people at first: **modules can't be built on their own.** A module has a `package.json` for its
dependencies, its exports and its tests. It has no build, no server and no separate typecheck. The application
typechecks every module's source and tests as one program. So a module is always checked against the *real* route
table, the *real* set of services and the *real* translations, and never against a stub that drifted.

A package is only a boundary if something stops other packages from reaching inside it. That's where the module's own
layout comes in.

## Inside a bounded context

Here is the jobs module, trimmed a little:

```
packages/jobs/
├── package.json            exports (what the app may use) and "published" (what other modules may use)
└── src/
    ├── index.ts            module definition: translations, navigation entries
    ├── routes.ts           the route table (plain data)
    ├── routes/             React Router route modules: thin loaders/actions and page components
    ├── components/         React components (DTOs in, markup out)
    ├── features/           *.server.ts: the HTTP side; each one runs a use case
    ├── domain/             entities, value objects, domain services: plain values and functions
    ├── application/
    │   ├── ports/          outbound ports (Effect services)
    │   └── use-cases/      Effect programs
    ├── infrastructure/     adapters for the ports
    ├── api.ts              the published API: a service and its DTOs
    └── layer.server.ts     the module's Effect layer
```

The folders follow the usual DDD layering, and the rules are checked, not just suggested:

- `domain/` is pure. It doesn't import React, UI code or Effect services. `domain/Match.ts`, for example, is a plain,
  explainable scoring function: skills count most, then job title, then years of experience.
- `application/` orchestrates the domain through ports. It never touches React or HTTP.
- Route modules and components never import `infrastructure/`. A loader calls a function in `features/`, and that
  function runs a use case.
- Components get plain DTOs. No domain type ever reaches the browser.

### The published API

Each module decides what the rest of the world may see, in two places in its `package.json`:

```json
{
  "name": "@app/jobs",
  "exports": {
    ".": "./src/index.ts",
    "./api": "./src/api.ts",
    "./layer.server": "./src/layer.server.ts",
    "./routes": "./src/routes.ts",
    "./routes/*": "./src/routes/*"
  },
  "app": {
    "kind": "module",
    "published": ["./api"]
  }
}
```

`exports` lists what the *application* may import: the route table, the route modules, the Effect layer. `published`
is narrower. It lists what *other modules* may import, and for jobs that's just `./api`. Node, Vite and TypeScript all
refuse to resolve a file a package doesn't export. A lint rule refuses any import from another module that isn't in its
`published` list.

`api.ts` is the module's **open host service**: an Effect service plus the DTOs it speaks in.

```ts
export class JobMatches extends Context.Service<
  JobMatches,
  {
    /** How many jobs near the citizen match their experience strongly (or better). */
    readonly strongMatchesFor: (citizen: AuthUser) => Effect.Effect<number>;
  }
>()('@app/jobs/JobMatches') {}
```

### Two ways to depend on another context

Modules call each other in two different ways, on purpose:

![Context map: the dashboard consumes profile, benefits and jobs directly; jobs reaches profile and employment records through anti-corruption layers]({{ '/assets/images/2026-11-10-modular-monolith/context-map.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

- **Customer/supplier.** The dashboard owns no data. It asks profile who the citizen is, asks benefits which programs
  might help, and asks jobs how many postings match. It uses each supplier's language as-is, because all it does is
  display the answers.
- **Anti-corruption layer.** Jobs needs to know about the citizen too, but it thinks in terms of a *candidate* with
  skills and years of experience, not a *citizen record*. So jobs defines its own port in its own language, and exactly
  one adapter translates profile's API into it. We'll see that adapter shortly.

Either way, a call between modules is a plain function call inside one process. There's no network hop, no
serialization and no API version to keep compatible at run time. The contract is still real, though. It's just
enforced at build time and in code review instead of on the wire.

### Who enforces all this

A single script, `check-boundaries.ts`, runs as part of `lint`. It checks things a reviewer shouldn't have to spot by
eye:

- **Direction.** Nothing depends on the application. The kernel depends on nothing, and `ui` depends only on the
  kernel. The module graph has no cycles.
- **Published APIs only.** A module may import another module only through an entry listed in `published`.
- **Declared dependencies.** If a module imports another workspace package at run time, that package must be in its
  `dependencies`, so `package.json` always shows the real module graph.
- **No reaching out.** A relative import never leaves its package.
- **Layering** inside each module, as described above.
- **Owned infrastructure.** Only the identity module may use the OIDC client or Redis, and only identity may make
  outbound network calls. Every other module reaches the outside world through a port.

`CODEOWNERS` covers the social side. Each module belongs to one team. The contract files (`api.ts` and `package.json`)
belong to an architecture group, so adding an edge to the module graph is a reviewed decision. The boundaries script
even checks that `CODEOWNERS` keeps up: every workspace has an owner, and every contract file is owned by the
architecture group alone.

That covers the layout. Inside each module, though, the interesting part is how the layers connect: the domain is
plain code, and everything else reaches the world through ports. That's where Effect comes in.

## Ports and adapters, wired by Effect

If you haven't used [Effect](https://effect.website), you need one idea for the rest of this post. An
`Effect<A, E, R>` is a description of a program that succeeds with an `A`, can fail with a typed error `E`, and needs
the services `R` before it can run. That third parameter, `R`, is the one that matters here.

### A port is a service

A port is a `Context.Service`: a typed key plus the interface behind it.

```ts
/** Outbound port: the jobs on offer. */
export class JobBoard extends Context.Service<
  JobBoard,
  {
    readonly postings: Effect.Effect<readonly JobPosting[]>;
    readonly find: (jobId: string) => Effect.Effect<Option.Option<JobPosting>>;
  }
>()('@app/jobs/JobBoard') {}
```

There's no decorator, no reflection and no container to configure. It's a class you can `yield*` from inside an Effect
program.

### A use case declares its ports in its type

Here is the use case behind `/en/jobs`:

```ts
export const SearchJobs = (request: SearchRequest) =>
  Effect.gen(function* () {
    const user = yield* CurrentUser;
    const candidate = yield* candidateWithSkills(user);
    const shortlist = yield* (yield* Shortlists).find(user.subject);
    const postings = yield* (yield* JobBoard).postings;
    const location = request.location ?? `${candidate.city}, ${candidate.province}`;

    // Pure domain code: filter, score, sort.
    const ranked = rank(postings, candidate, shortlist, { ...request, location });

    return { candidate, location, results: paginate(ranked, request.page ?? 1) /* … */ };
  }).pipe(Effect.withSpan('SearchJobs'));
```

You don't write its type by hand. TypeScript infers it:

```ts
Effect<SearchResult, never, CurrentUser | CandidateProfiles | SkillProfiles | Shortlists | JobBoard>
```

That last parameter is the list of ports this use case needs, and the compiler tracks it for you. If you come from
Spring, it's a lot like constructor injection, except the wiring is checked at compile time and not when the context
starts. If you add a `yield* SomeNewPort` and nothing ever provides `SomeNewPort`, the build fails.

### Adapters are layers

An adapter implements a port and is packaged as a `Layer`. The in-memory job board is about as simple as one gets:

```ts
export const layer = Layer.effect(
  JobBoard,
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const postings = SAMPLES.map(/* date each sample relative to now */);
    return JobBoard.of({
      postings: Effect.succeed(postings),
      find: (jobId) => Effect.succeed(Option.fromNullishOr(postings.find((p) => p.id === jobId))),
    });
  }),
);
```

The anti-corruption layer is also just an adapter. Jobs has its own port, `CandidateProfiles`, and this adapter
implements it on top of profile's published `CitizenDirectory`:

```ts
/**
 * Profile's language (a citizen) becomes ours (a candidate with skills and
 * experience) here, and only here: if profile's API changes, this file
 * changes; the jobs domain doesn't.
 */
export const layer = Layer.effect(
  CandidateProfiles,
  Effect.gen(function* () {
    const directory = yield* CitizenDirectory; // profile's published API
    const work = yield* WorkExperience;        // another of jobs' own ports
    return CandidateProfiles.of({
      candidateFor: (citizen) =>
        Effect.gen(function* () {
          const summary = yield* directory.summaryOf(citizen);
          const experience = yield* work.experienceOf(citizen).pipe(
            Effect.catchTag('ExperienceUnavailable', () =>
              Effect.logWarning('employment records unavailable; matching without experience').pipe(
                Effect.as('unavailable' as const),
              ),
            ),
          );
          return toCandidate(summary, experience);
        }),
    });
  }),
);
```

In the whole jobs module, this is the only file that knows profile's API exists. It also makes a domain decision at the
seam: if employment records are down, jobs still answers, with a candidate flagged as having unknown experience.

Put together, the module looks like a textbook hexagon:

![The jobs module as a hexagon: domain at the centre, use cases and ports around it, route modules driving it from the left, adapters implementing ports on the right]({{ '/assets/images/2026-11-10-modular-monolith/hexagon.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

### Tests swap a port in one line

Because a port is just a key in `R`, a test provides whatever it likes for it. Here's the anti-corruption layer tested
against a stand-in for profile and a failing employment-records port:

```ts
it.effect('degrades to a candidate flagged as having unreadable experience', () =>
  Effect.gen(function* () {
    const candidate = yield* (yield* CandidateProfiles).candidateFor(USER);
    assert.strictEqual(candidate.experienceUnavailable, true);
    assert.deepStrictEqual(candidate.skills, []);
  }).pipe(
    Effect.provide(
      ProfileCandidates.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CitizenDirectory, CitizenDirectory.of({
              summaryOf: () => Effect.succeed({ givenName: 'Sam', city: 'Ottawa', province: 'ON' }),
            })),
            Layer.succeed(WorkExperience, WorkExperience.of({
              experienceOf: () => Effect.fail(new ExperienceUnavailable()),
            })),
          ),
        ),
      ),
    ),
  ),
);
```

There are no mocking libraries and no monkey-patching. The test builds a smaller graph of layers than production does.

So each module ends up handing back one `Layer`. Something has to put all of those together.

## The composition root

A module's `layer.server.ts` merges its adapters with the services it publishes:

```ts
const Adapters = Layer.mergeAll(
  InMemoryJobBoard.layer,
  InMemoryShortlists.layer,
  InMemoryApplyStores.layer,
  ProfileCandidates.layer.pipe(Layer.provide(EmploymentExperience.layer)),
);

/** Requires profile's CitizenDirectory and employment-records' EmploymentRecords (the application provides them). */
export const layer = Layer.merge(JobMatchesService.layer, JobMatchesService.activityLayer).pipe(
  Layer.provideMerge(Adapters),
);
```

The published service has one small trick worth showing. `JobMatches` is built on top of jobs' own use cases, which
need jobs' private ports. I don't want those ports showing up in the *dashboard's* `R` just because the dashboard calls
`JobMatches`. So the service captures its dependencies when the layer is built, and provides them itself:

```ts
export const layer = Layer.effect(
  JobMatches,
  Effect.gen(function* () {
    const services = yield* Effect.context<CandidateProfiles | JobBoard | Shortlists | SkillProfiles>();
    return JobMatches.of({
      strongMatchesFor: (citizen) => countMatches(citizen, 'strong').pipe(Effect.provideContext(services)),
    });
  }),
);
```

From the outside, `strongMatchesFor` returns an `Effect<number>` that needs nothing. Jobs' internals stay internal,
even at the type level.

### Five tiers

The application's `server/runtime.ts` stacks every module's layer in tiers that mirror the module graph:

```ts
/** Modules whose layers need no other module's services. */
const Independent = Layer.mergeAll(Identity.layer, Benefits.layer, EmploymentRecords.layer, Payments.layer);

/** Profile reads employment records. */
const Profiled = Profile.layer.pipe(Layer.provideMerge(Independent));

/** Jobs reads profile and employment records; employment insurance reads employment records. */
const Services = Layer.mergeAll(Jobs.layer, EmploymentInsurance.layer).pipe(Layer.provideMerge(Profiled));

/** Life events derive from what every service above publishes. */
const Events = LifeEvents.layer.pipe(Layer.provideMerge(Services));

/** The dashboard is the sink: it composes the layers above, and nothing depends on it. */
const Modules = Dashboard.layer.pipe(Layer.provideMerge(Events));

export const AppLayer = Demo.pipe(Layer.provideMerge(Modules));
```

![Module layers stacked in five tiers, from independent modules at the bottom to the dashboard at the top, inside the server layer and NodeRuntime.runMain]({{ '/assets/images/2026-11-10-modular-monolith/layer-tiers.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

Two properties fall out of this for free.

**A missing service is a compile error.** The server only accepts a `Layer` whose remaining requirements are `never`.
If jobs starts needing a service that no tier provides, `AppLayer` won't typecheck.

**Bad configuration stops the process at boot.** Layers are built once, eagerly, when the process starts. Settings are
read with Effect's `Config`. A missing setting, a session secret that's too short, or an identity provider that doesn't
answer means the layer fails to build, and the process exits before it accepts a single request.

Choosing an adapter from configuration is also just a layer:

```ts
const stores = { memory: InMemorySessionStore.layer, redis: RedisSessionStore.layer } as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    return Layer.merge(stores[yield* StoreKind], Session.secretLayer); // SESSION_STORE=memory|redis
  }),
);
```

At this point `AppLayer` describes the whole application. Next, something has to serve it.

## The server is a Layer too

The process entry is one line:

```ts
runServer({ layer: AppLayer, wrap: (handler) => withSession(handler) });
```

and `runServer` is hardly longer:

```ts
export const runServer = <A, E>(options: ServerOptions<A, E>): void => {
  NodeRuntime.runMain(Layer.launch(makeServerLayer(options)), { teardown });
};
```

The HTTP server itself is a `Layer`, built with Effect's platform HTTP modules. `NodeRuntime.runMain` owns the process:
it handles `SIGTERM` and `SIGINT`, interrupts the program, and runs every finalizer in reverse order. The custom
`teardown` makes a graceful stop exit with code `0`. By default an interrupt exits with `130`, which an orchestrator
reads as a crash.

Every request passes through a small middleware stack, outermost first:

```ts
const middleware = HttpMiddleware.make((app) =>
  Tracing.middleware(RequestId.middleware(HttpMiddleware.logger(app))),
);
```

- **Tracing** opens the HTTP server span and continues an incoming `traceparent`, using OpenTelemetry under the hood.
- **RequestId** takes a well-formed `x-request-id` header or generates one. It adds the ID to every log line and to the
  span, and provides it as a `CurrentRequest` service. It echoes the header from a pre-response handler, so the header
  is set even on error responses.
- **The logger** writes the access log.

A few more details from the server layer:

- **It only listens once it can answer.** The server loads the SSR bundle (or starts Vite) *before* it opens the port.
  If it accepted a connection while it was still loading, that request would hang, and so would a readiness probe.
- **In production**, hashed assets under `/assets/` are served with a one-year immutable cache. Anything that isn't a
  file falls through to React Router.
- **In development**, Vite runs in middleware mode as a scoped resource (`Effect.acquireRelease`), so it closes when the
  program's scope closes. Vite registers its own signal handlers that call `process.exit()`. The server removes them so
  that `runMain` stays the only thing in charge of shutdown.
- **There's no server build step.** `server.ts` runs directly under Node's built-in TypeScript type stripping.

### The session is an Effect wrapper

`withSession` wraps the React Router handler. It reads a signed `__Host-` cookie, loads the session from the store, and
keeps the request's session state in a `Ref`. It provides a `CurrentSession` service to everything inside. It also
registers a pre-response handler that saves the session and sets or clears the cookie, so even an error response gets
the cookie right. A session that's never written is never stored. Tokens from the identity provider never reach the
browser.

By the time a request reaches the end of this chain, it carries a full Effect context: the application's services, the
server span, the log annotations, `CurrentRequest` and `CurrentSession`. Next it goes to React Router, which knows
nothing about Effect.

## React Router 8 owns the page

React Router runs in framework mode with server rendering on. Its job is everything a page needs: matching URLs,
layouts, loaders and actions, rendering, and client-side navigation.

### Route config built from packages

Each module declares its pages as plain data:

```ts
export const routes = defineModuleRoutes({
  module: 'jobs',
  idPrefix: 'JOB',
  routes: {
    account: [
      { id: 'JOB-0001', file: '@app/jobs/routes/search.tsx', paths: { en: '/en/jobs', fr: '/fr/emplois' } },
      { id: 'JOB-0002', file: '@app/jobs/routes/job.tsx', paths: { en: '/en/jobs/:jobId', fr: '/fr/emplois/:jobId' } },
      // …
    ],
  },
});
```

A few things to notice:

- **`file` is a package specifier**, not a path. While React Router loads its route config, the application resolves
  each one with `require.resolve`, through the module's package `exports`. So a module decides which of its files are
  route modules, and a page can't point into another module's internals.
- **Every page has an English and a French path.** The route table comes from our
  [i18n routing library]({% post_url 2025-09-05-i18n-rr7 %}). It fails at startup if an ID is duplicated or a
  translation is missing. The URL is the *only* source of the language. We never look at a cookie or the
  `Accept-Language` header, and a lint rule bans the helper that would.
- **Pages are grouped by area**: `public`, `onboarding` or `account`. The area decides which layout wraps the page.

The application's `routes.ts` puts everything together:

```ts
export default [
  index('routes/language-selection.tsx'),
  ...untranslatedRoutes(routeTables).map(({ id, path, file }) => route(path, toAppFile(file), { id })),
  ...toRouteConfigEntries(resolveRouteFiles(i18nRoutes)),
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
```

### Layouts and middleware guards

`/en/jobs` is an `account` page, so it renders inside the account layout. That layout uses React Router's middleware to
guard every page under it:

```ts
export const middleware: Route.MiddlewareFunction[] = [requireSignedIn, requireConsent];

export const loader = ({ context }: Route.LoaderArgs) => ({ user: signedInUser(context) });
```

`requireSignedIn` comes from the identity module, and `requireConsent` comes from profile. The layout doesn't know how
either one works. A signed-out request gets a document redirect to sign in, because signing in leaves the application
for the identity provider, and a client-side navigation can't follow it there. A signed-in request gets the user
recorded in the router context. The layout also renders the side navigation, which every module contributes entries to
through its `defineModule` definition.

### Thin route modules

The jobs page's route module barely does anything:

```ts
export const loader = ({ context, request }: LoaderFunctionArgs) => loadJobs(context, request);
export const action = ({ context, request }: ActionFunctionArgs) => changeShortlist(context, request);

export default function JobSearchPage() {
  const { results, total, query /* … */ } = useLoaderData<typeof loader>();
  // …render
}
```

`useLoaderData<typeof loader>()` gives the component the exact DTO type the loader returns. The search itself is a
plain `GET` form, so its state lives in the URL. It works without JavaScript, and you can bookmark a search. Moving
between modules (from jobs to benefits, say) is a client-side navigation inside one React tree and one router. Our
end-to-end tests check that crossing every module in the navigation never reloads the document.

That leaves two unanswered questions in that loader. What exactly is `context`? And how does `loadJobs` reach
`SearchJobs`, which needs five services that React Router has never heard of?

## The bridge

The answer is a small piece of the kernel that joins the two runtimes. Here's the whole trip for our request:

![Sequence diagram of one request for /en/jobs, from the Effect HTTP server through React Router to the jobs module and its adapters, and back]({{ '/assets/images/2026-11-10-modular-monolith/request-lifecycle.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

### From Effect to React Router

At the end of the middleware chain, the Effect server hands the request to React Router's request handler. Before it
does, it captures the request's **entire Effect context**:

```ts
const makeReactRouterHandler = (loadBundle: () => Promise<SsrBundle>) => {
  const handleRequest = createRequestHandler(async () => (await loadBundle()).build, mode);

  return Effect.gen(function* () {
    // This request's services, server span, log annotations, CurrentRequest, CurrentSession…
    const context = yield* Effect.context();

    return yield* HttpEffect.fromWebHandler(async (request) => {
      const bundle = await loadBundle();
      return handleRequest(request, bundle.createAppLoadContext({ context, signal: request.signal }));
    });
  });
};
```

`createAppLoadContext` stores that context, together with the request's abort signal, in React Router's
`RouterContextProvider` under a typed key:

```ts
const requestScopeKey = createContext<RequestScope>();

export const createAppLoadContext = (scope: RequestScope): RouterContextProvider => {
  const context = new RouterContextProvider();
  context.set(requestScopeKey, scope);
  return context;
};
```

One gotcha here cost me an afternoon. React Router context keys are compared by identity. The key that *sets* the scope
and the key that loaders *read* it with must be the same object. That only holds if both come from the same module
graph. So `createAppLoadContext` is re-exported from the SSR bundle's entry, next to React Router's server build, and
the server always takes both from the bundle.

### From React Router back to Effect: `run()`

Loaders, actions and middleware all call one function to get back into Effect. Here it is, simplified a little:

```ts
export async function run<A, E extends Tagged, H extends ErrorHandlers<E>>(
  context: Readonly<Pick<RouterContextProvider, 'get'>>,
  effect: Effect.Effect<A, E, BridgeServices>,
  options: { readonly span: string; readonly onError: H },
): Promise<A | ReturnType<H[keyof H]>> {
  const scope = requestScope(context);
  const user = getAuthUser(context);
  const services = user === undefined ? scope.context : Context.add(scope.context, CurrentUser, user);

  const exit = await Effect.runPromiseExitWith(services)(
    effect.pipe(Effect.tapCause((cause) => logOutcome(options.span, cause)), Effect.withSpan(options.span)),
    { signal: scope.signal },
  );

  if (Exit.isSuccess(exit)) return exit.value;          // a plain DTO (or a redirect)
  const failure = Cause.findError(exit.cause);
  if (failure._tag === 'Failure') throw Cause.squash(exit.cause); // defect or interruption: a 500
  return options.onError[failure.success._tag](failure.success);  // a typed failure: its handler
}
```

It does a few jobs in a small space:

- **It runs the effect inside the request's own context.** The use case can `yield*` any application service, and its
  spans become children of the HTTP server span. Its log lines carry the request ID.
- **It adds `CurrentUser`.** The account layout's guard recorded the signed-in user in the router context, and `run()`
  turns that into a `CurrentUser` service. That's why `SearchJobs` can simply `yield* CurrentUser`. A module never sees
  the session, the tokens or the identity provider, only a plain `AuthUser`.
- **It follows the request's lifetime.** If the browser goes away, the abort signal interrupts the running effect. That
  gets logged at info level, not as an error.
- **It keeps three kinds of failure apart.** Expected failures are logged at debug level and mapped to a response.
  Defects are logged as errors and become a 500 through the route's error boundary. Interruptions are just logged.

So here's `loadJobs`, the function the jobs loader calls:

```ts
export const loadJobs = (context: Context, request: Request) => {
  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').slice(0, 100);
  // …parse the rest of the search from the URL

  return run(
    context,
    Effect.gen(function* () {
      const found = yield* SearchJobs({ query, location, savedOnly, province, sort, page });
      return {
        query,
        total: found.results.total,
        results: found.results.items.map(({ posting, score, rating, saved, top }) => ({
          id: posting.id,
          title: posting.title,
          employer: posting.employer,
          score,
          rating,
          // …a plain DTO, nothing from the domain
        })),
      };
    }),
    { span: 'jobs.search', onError: {} },
  );
};
```

`onError: {}` is not a shortcut. It's a statement that `SearchJobs` can't fail in an expected way, and the compiler
holds us to it. `ErrorHandlers` is a mapped type with one required handler per error tag:

```ts
type ErrorHandlers<E extends { readonly _tag: string }> = {
  readonly [K in E['_tag']]: (error: Extract<E, { readonly _tag: K }>) => ReturnType<typeof data> | Response;
};
```

If a use case gains a new failure, every call site that doesn't handle it stops compiling.

### A second request: when things can fail

`/en/jobs` never fails in an interesting way, so let's look at a different request for a moment. A citizen edits their
phone number on their profile, and the form posts back. The `ChangeDetail` use case can fail in two ways. The domain can
reject the value (`DetailRejected`), or someone may have changed the profile in another tab since this form was opened
(`RevisionConflict`, an optimistic-concurrency check).

```ts
return run(context, ChangeDetail(field, value, version).pipe(Effect.map(() => redirect(pageWithout(request, 'edit')))), {
  span: 'profile.details.change',
  onError: {
    DetailRejected: ({ problem }) =>
      data({ fieldError: { field, problem, value }, conflict: false }, { status: 400 }),
    // Someone (another tab, another device) changed the profile since this form was opened.
    RevisionConflict: () => data({ fieldError: null, conflict: true }, { status: 409 }),
  },
});
```

The use case knows nothing about HTTP status codes. The route module knows nothing about how a phone number is
validated. The bridge is the one place where a typed domain failure becomes a 400 or a 409, and the compiler won't let
anyone forget a case.

### How the kernel learns about the app

That leaves one puzzle. `run()` lives in the kernel, and the kernel depends on nothing. Yet `run()` rejects an effect
that needs a service no module provides. How does the kernel know which services exist?

It doesn't. The application tells it, through TypeScript's declaration merging:

![The kernel declares an empty Register interface; the app fills it in; every module is then typechecked against the real app]({{ '/assets/images/2026-11-10-modular-monolith/register-inversion.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

The kernel declares an empty interface and derives its types from whatever ends up in it:

```ts
export interface Register {}

export type BridgeServices = Register extends { readonly services: infer S }
  ? S | CurrentRequest | CurrentUser
  : any;
```

The application fills it in from `app/register.ts`:

```ts
declare module '@app/kernel/bridge.server' {
  interface Register {
    // Every module's services, plus the per-request session.
    readonly services: Layer.Success<typeof Runtime.AppLayer> | SessionServices;
  }
}

declare module '@app/kernel/routing' {
  interface Register {
    readonly routing: typeof I18nRoutes.i18nRouting;
  }
}

declare module 'i18next' {
  interface CustomTypeOptions {
    readonly defaultNS: 'ui';
    readonly resources: (typeof I18n.resources)['en'];
  }
}
```

It's dependency inversion at the type level. Imports only point toward the kernel, but because every module is
typechecked inside the application's program, every module sees the *real* types:

- `run()` accepts only effects whose services `AppLayer` actually provides.
- A link to a page that doesn't exist, in any module, is a type error, because route keys are those package specifiers.
- A translation key that doesn't exist is a type error.

## Resilience and observability at the seams

A modular monolith can still have partial failures. The modules are in-process, but many of their adapters stand in
for real back-end systems that will be slow or down some of the time. The dashboard feels this most, because it
composes six or seven modules on one page.

The kernel has a tiny helper for that:

```ts
export type Part<A> = { readonly state: 'ready'; readonly value: A } | { readonly state: 'unavailable' };

export const settle = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, timeout = PART_TIMEOUT) =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.map((value): Part<A> => ({ state: 'ready', value })),
    Effect.catchCause((cause) =>
      Effect.logWarning(`${name} unavailable; showing the page without it`, cause).pipe(
        Effect.as<Part<A>>({ state: 'unavailable' }),
      ),
    ),
  );
```

The home page's use case runs each part through it, all at once:

```ts
const claim = settle('home: claim', (yield* ClaimStatus).of(user));
const applications = settle('home: job applications', (yield* JobApplicationsGlance).of(user));
const payments = settle('home: payments', (yield* PaymentsGlance).recent(user, 3));
// …

const [claimed, applied, paid, life, matches, news] = yield* Effect.all(
  [claim, applications, payments, lifeEvent, jobMatches, whatsNew],
  { concurrency: 'unbounded' },
);
```

![Six parts start together; one fails and one times out at 1.5 seconds; both become unavailable and the page still renders]({{ '/assets/images/2026-11-10-modular-monolith/settle-fanout.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

A typed failure, a defect or a timeout all end up as the same thing: a value the page knows how to render. A slow
payments system costs the citizen one card, not the whole page.

Observability comes almost for free from the bridge. Because `run()` executes inside the request's context, the trace
for our request nests naturally:

```
GET /en/jobs                       HTTP server span (Tracing middleware)
└── jobs.search                    run() in the loader
    └── SearchJobs                 the use case
```

Every log line along the way carries the same `requestId`. Spans can go to the console or to any OTLP endpoint.

Testing failure is part of the design too. In test mode (off by default; when it's off, these endpoints answer 404),
the application exposes two endpoints, both protected by a shared secret. One resets every module to its seed data. The other
switches a simulated back-end outage on or off. The composition root implements both on top of each module's
unpublished demo entry. The end-to-end suite uses them to prove that, for example, the dashboard still renders with
the payments system down.

## What we gave up, and what we got

|                              | Network boundaries                       | Boundaries in the build                         |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------- |
| Deployables                  | one per area, plus composition           | one                                             |
| Moving between areas         | often a full page load                   | client-side navigation                          |
| Contracts between areas      | URLs, payloads, shared session, run time | typed APIs and route keys, build time           |
| What enforces the boundaries | the network                              | package exports, a lint script, CODEOWNERS      |
| Version skew between areas   | something you manage                     | can't happen                                    |
| Releasing an area alone      | yes                                      | no: one release train                           |

The cost is real. Every team ships together, and one team's broken build blocks everyone. Being disciplined about
`main` and having a fast `check` command (typecheck, lint, boundaries, format and unit tests in one go) matter more here
than they would elsewhere.

What we got back is everything that tends to make split deployments expensive: no per-area platform, no session format
that several independently released apps have to agree on, no composition layer, and one developer experience. The
boundaries didn't go away. They moved somewhere cheaper to check.

This design is probably *not* right if your teams truly need independent release cadences, if they work in different
languages or runtimes, or if one area needs to scale very differently from the others. In those cases the network is
earning its keep.

## Wrapping up

The ideas aren't new: bounded contexts, published languages, anti-corruption layers, ports and adapters, and a
composition root. What made them cheap enough to apply everywhere was the tooling:

- **Packages and their `exports`** turn bounded contexts into something Node, Vite and TypeScript enforce.
- **Effect's `R` parameter and its layers** turn hexagonal architecture into something the compiler checks, with no
  container and no reflection.
- **The Effect runtime** owns the process and the HTTP edge: startup, configuration, shutdown, tracing and sessions.
- **React Router 8** owns the page: routes from packages, layouts, middleware guards and thin loaders.
- **A small bridge** carries one typed request context from the socket, through Effect and React Router, into a use
  case and back, and it maps every expected failure exhaustively.

If you take one thing from this post, I'd make it this: a boundary the compiler checks is cheaper than one the network
enforces, and usually more honest too.
