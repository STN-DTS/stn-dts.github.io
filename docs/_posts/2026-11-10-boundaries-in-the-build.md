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
needs to deploy on its own schedule, the modules don't give them that. Near the end I'll show the one narrow exception
I made, and what it costs. In exchange you get no version skew between pages, no composition layer to run, one
developer experience, and contracts the compiler checks.

## The shape: one app, many packages

The repository has two kinds of workspace: applications and packages. One application is the product. The other is
the exception I just mentioned, and I'll come back to it near the end.

![The app at the top wires in every package; modules in the middle each publish a small API; ui and the kernel sit at the bottom]({{ '/assets/images/2026-11-10-modular-monolith/repo-map.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

```
apps/web/                  the application: one build, one process, one image
  server.ts                process entry
  server/runtime.ts        composition root: every module's Effect layer
  server/http/             the Effect HTTP server
  app/routes.ts            React Router's route config, built from the modules
  app/register.ts          types the kernel with the real app (more on this later)
  app/routes/layouts/      three layouts; the language page and the 404
apps/cra-tax-slips/        the one exception: a frontend built and deployed on its own (near the end)
packages/
  kernel/                  shared kernel: the Effect ↔ React Router bridge, request scope, module contract, fragment slot
  ui/                      the design system
  identity/                sign-in, sign-out, the session, page guards
  profile/                 the citizen's record, contact details, consent
  benefits/                the program catalogue and the benefits finder
  jobs/                    job postings matched to the citizen, and their shortlist
  dashboard/               the account's home page
  mfe-host/                mounts the exception inside the account
  mfe-contract/            the mount contract both sides share
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

- `domain/` is pure. It doesn't import React, UI code or Effect services. `domain/match.ts`, for example, is a plain,
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
- **No dynamic code.** An `import()` of anything but a string literal is allowed in exactly one file, and you'll meet
  it near the end.
- **Other applications** may depend on shared packages only, never on a module.

`CODEOWNERS` covers the social side. Each module, and each application, belongs to one team. The contract files (`api.ts` and `package.json`)
belong to an architecture group, so adding an edge to the module graph is a reviewed decision. The boundaries script
even checks that `CODEOWNERS` keeps up: every workspace has an owner, and every contract file is owned by the
architecture group alone.

What the script can't see is GitHub's side of that file. If a team named in `CODEOWNERS` doesn't exist, or can't write
to the repository, GitHub quietly ignores it. The files it was meant to guard then have no code owner at all, and anyone
with write access can approve them. So the teams are code too. A small Terraform module, applied with Terragrunt,
manages every team `CODEOWNERS` names, who is in each one, and each team's access to the repository.

The list of teams lives in one file, `.github/code-owner-teams.json`. The boundaries script checks `CODEOWNERS` against
it, and the Terragrunt stack reads the same file and passes it to the module, which refuses to plan unless the two
match. Here's that check, simplified a little:

```terraform
validation {
  condition     = toset(keys(var.teams)) == toset(var.required_team_slugs)
  error_message = "The managed teams must be exactly required_team_slugs (the CODEOWNERS team registry)."
}
```

So adding a team is one pull request that touches three files: the registry, `CODEOWNERS` and the stack. Lint checks
that the first two agree, and the plan checks the third. The stack is applied *before* the pull request merges, so
`CODEOWNERS` never names a team that doesn't exist yet.

A few details make the teams as hard to drift as the code:

- **Membership is authoritative.** The stack lists who is in each team. Anyone added through GitHub's settings page is
  removed on the next apply. Joining a team is a pull request against `infra/`, which the platform team owns, so it
  gets reviewed like any other change.
- **Every team gets write access.** `CODEOWNERS` ignores an owner that can't push, so the stack grants it explicitly.
- **An empty team fails to plan.** An authoritative, empty member list would empty the team on GitHub, and quietly
  leave its files without an owner.
- **Every name has a project prefix**, like `msca-jobs` or `msca-architecture`, so a team can't be mistaken for
  another project's team in a shared organization.

Two limits, stated plainly. The state is a local file for now, outside the worktree, with no locking between machines.
One person applies, and anyone else rebuilds the state by importing what's already on GitHub. A shared backend comes
before production. And the stack doesn't cover branch protection, the setting that turns a code owner's review into a
requirement.

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

/** Profile reads employment records. The island host reads identity, and manifests through the app's HTTP adapter. */
const Profiled = Layer.mergeAll(Profile.layer, MfeHost.layer.pipe(Layer.provide(HttpManifestSource.layer))).pipe(
  Layer.provideMerge(Independent),
);

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
browser. (The island near the end gets a narrower, short-lived token of its own.)

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

## One session, kept apart

The bridge gives every use case the request's whole context, and that context includes the session. Identity needs it,
because that's where it keeps the citizen's authentication. For every other module, though, a shared session is a risk.
There's one per browser, shared by every module and by every tab the citizen has open. Left alone, it turns into the
place where modules quietly pass data to each other, and where two tabs overwrite each other's work.

So each module gets its own slice of the session, and each tab gets its own slice of that.

### A slice per bounded context

Modules still keep the citizen's real data in their own repositories, keyed by the citizen. The session is only for
short-lived state: what someone is doing during this visit. When a module needs that, it asks identity for its own view
of the session:

```ts
export interface ContextSession {
  readonly context: string;
  readonly get: Effect.Effect<ContextData>;
  /** Replaces this context's slice with `f(current)`. */
  readonly update: (f: (current: ContextData) => ContextData) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  /** Reads another context's slice; denied unless `owner` is in this context's grants. */
  readonly readFrom: (owner: string) => Effect.Effect<ContextData, SessionAccessDenied>;
}

export const contextSession = (options: {
  readonly context: string;
  /** Other contexts whose slices this one may read. Empty by default. */
  readonly mayReadFrom?: readonly string[];
}): Effect.Effect<ContextSession, never, CurrentSession> => /* … */;
```

`contextSession` is in identity's `published` list, as `./session.server`. The raw `CurrentSession` service isn't. The
application imports it to type the bridge, but no module can import it, so no module can `yield*` it. The boundaries
script guards it the same way it guards every other module's internals.

A module reads and writes its own slice, and that's all it can write. It can read another context's slice only if it
names that context in `mayReadFrom`. Otherwise `readFrom` fails with a typed `SessionAccessDenied`, and the exhaustive
`onError` you saw in the bridge makes the caller decide what that means. Identity's authentication isn't a slice, so no
grant reaches it. Even the names are checked: a context can't call its slice `__proto__`.

A grant is a line of code next to the call, so letting one context look at another's state shows up in a diff. It
can't happen by accident.

There's one more constraint, and it comes from running several replicas. During a rolling deployment, a replica may read
a session written by an older or a newer version of itself. So the stored shape of the session can only grow. The slices
went in as one new optional field, validated on the way in like everything else in the store.

### A slice per tab

A slice per context still isn't enough, because the session belongs to the browser, not to the tab. We already saw this
with the profile form, where someone may have changed the profile "in another tab". The benefits finder ran into it next.

The finder now remembers the citizen's last search, so coming back to `/en/benefits` picks up where they left off. Store
that search once per session, though, and two tabs fight over it. Search for dental care in one tab and pensions in
another, return to the first, and it shows you pensions.

The fix is our [tab ID hook]({% post_url 2025-09-05-browser-tab-isolation %}). In the page, `useTabId()` gives each tab
a short ID of its own, kept in that tab's `sessionStorage` and added to the URL as `tid`. In the loader,
`getTabId(request)` reads it back. The finder then keeps one selection per tab inside benefits' slice:

```ts
const slice = contextSession({ context: 'benefits' });

export const rememberSelection = (tabId: string, selection: FinderSelection) =>
  Effect.gen(function* () {
    const { update } = yield* slice;
    yield* update((data) => {
      const { [tabId]: _replaced, ...others } = tabsOf(data);
      // Re-inserting last makes the oldest tabs the first to be dropped.
      const kept = Object.entries(others).slice(-(MAX_TABS - 1));
      return { ...data, tabs: { ...Object.fromEntries(kept), [tabId]: selection } };
    });
  });
```

The loader's rule is simple. If the URL asks for something (a query, a situation or a view), that's the tab's new
selection, and it's stored under the tab's ID. If the URL asks for nothing, the tab gets its own last selection back. The
finder's own links always name a view, so an otherwise empty URL is never mistaken for "give me my last search".

A few small details keep this honest:

- **A `tid` that doesn't look like one the hook generates is ignored.** It never becomes a key in the session.
- **At most ten tabs are remembered.** The oldest is dropped first, so a long day of browsing can't grow the session
  without limit.
- **Session data is untyped JSON.** So each field is parsed again on the way out, like any other input the module
  didn't just create.
- **The URL still wins.** Without JavaScript there's no tab ID, so the finder just reads the search from the URL, as it
  always did. A search is still a plain `GET` form that you can bookmark.

An end-to-end test opens two tabs on one session, searches for something different in each, and checks that each tab
gets its own search back.

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

## One exception: an area that ships on its own

At the start I said every team rides the same release train. That's true for every module. But one area of this
account isn't really ours. Tax slips belong to the Canada Revenue Agency (CRA): a different organization, with its own
team and its own release schedule. The citizen shouldn't notice any of that. They should see the same header, the same
side navigation, the same session and the same language toggle.

So I made one explicit, limited exception: an **island**. It's a separate frontend, built and deployed on its own, and
mounted inside the account's chrome under `/en/canada-revenue-agency/*` and `/fr/agence-du-revenu-du-canada/*`. It is
not the first step toward turning modules into micro-frontends. That isn't on the table. It's what we do for the rare
area that can't share our build.

To keep this concrete, here's a third request: the same citizen opens `/en/canada-revenue-agency/slips/T4-2025-0003-1`
to look at last year's T4. Almost everything up to the loader is what you've already seen: the account layout, the
`requireSignedIn` and `requireConsent` middleware, and `run()`. Only the body of the page is different.

![One page, two runtimes: the host renders the chrome on the server; the island renders inside a shadow root in the browser; only the mount contract crosses between them]({{ '/assets/images/2026-11-10-modular-monolith/island-anatomy.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

### The host is just another module

The host side of the island is an ordinary bounded context, `@app/mfe-host`, built the same way as every other module.
Its domain knows what a remote manifest and a mount path are. Its ports are a `RemoteRegistry`, a `ManifestSource` and
`DelegatedAccess`. It reaches identity through an anti-corruption layer, publishes nothing, and sits in the second tier
of the composition root, next to profile.

Its route table owns one splat page per remote:

```ts
account: [
  {
    id: 'MFE-0001',
    file: '@app/mfe-host/routes/cra-tax-slips.tsx',
    paths: { en: '/en/canada-revenue-agency/*', fr: '/fr/agence-du-revenu-du-canada/*' },
  },
],
```

Because it's an `account` page, it gets the account layout and its guards for free. Everything under the prefix belongs
to the island.

The island itself is a second *application*, `apps/cra-tax-slips/`, with its own build, its own container image, its own
deployment and its own team in `CODEOWNERS`. The boundaries script has a rule for it: an application other than the main
one may depend on shared packages only. It can't import a module, published API or not.

### The contract is a package with no dependencies

The only thing the host and the island share is a small package, `@app/mfe-contract`. It has no dependencies at all.
The kernel can't hold it, because the kernel imports React and the island doesn't use React.

```ts
export const MOUNT_CONTRACT = 'app-mfe/1';

export interface MountContext {
  /** The host path the remote owns: `/en/canada-revenue-agency`. */
  readonly basename: string;
  /** A change of language is a new document, so a new mount. */
  readonly language: 'en' | 'fr';
  /** The host owns history. A target outside `basename` is refused. */
  navigate(to: string, options?: { readonly replace?: boolean }): void;
  /** A short-lived bearer token for the remote's API. */
  getAccessToken(): Promise<string>;
  /** Called on every host navigation under `basename`. Returns an unsubscribe. */
  onLocationChange(listener: (location: MountLocation) => void): () => void;
}

/** Idempotent: aborts in-flight work, removes listeners and empties what it rendered. */
export type Unmount = () => void;

export interface RemoteModule {
  readonly contract: string;
  mount(el: HTMLElement, ctx: MountContext): Unmount;
}
```

If you come from Java, think of it as an SPI jar: one interface, implemented on the other side of a deployment boundary.
Versioning is deliberately strict. The host accepts the same major version only. A minor version may add optional fields
and nothing else. A breaking change becomes `app-mfe/2`, and the host then supports both versions while remotes migrate.

This is the one place in the post where a boundary is checked at run time instead of by the compiler. The compiler still
checks each side against the contract. What it can't check is that the code the host loads tomorrow was built against
the same version. A version check and an integrity hash do that job instead.

### One router

The island lives in the host's page, so it must not fight the host over the URL. The host's React Router owns the
browser's history, and the island never calls `history.pushState` itself. Its own paths are language-neutral (`/` and
`/slips/:slipId`). When it wants to move, it asks:

```ts
navigate: (to, options = {}) => {
  const target = withinBasename(basename, to);
  if (target === undefined) {
    console.warn(`refused a remote's navigation outside ${basename}`);
    return;
  }
  void latest.current.navigate(target, { replace: options.replace === true });
},
```

`onLocationChange` is there for the other direction. React Router's `pushState` fires no `popstate` event, so without a
callback the island couldn't follow the host's own links: the side navigation, back and forward. The host's outlet
watches `useLocation()` and tells the island whenever the path is still under its prefix.

The language toggle swaps only the bilingual prefix (`/en/canada-revenue-agency` becomes
`/fr/agence-du-revenu-du-canada`), keeps the rest of the path and reloads the document. A new language is simply a new
mount. The end-to-end tests check that the side navigation can move into and out of the island without reloading the
document, and that the toggle keeps the slip that was open.

### A different runtime, the same architecture

The island uses **Preact**, not React, and it uses neither Effect nor our design system. That's on purpose. A different
runtime proves the two sides really share nothing: no shared React, no clash between two copies of React's hooks, and
no import maps or Module Federation to keep in step. Preact is about 4 KB, and its TSX looks familiar.

Inside, though, it's built the way everything else in this post is built: a `domain/` (tax slips, tax years, money), an
`application/` with ports (`TaxSlipsApi`, `AccessTokenProvider`, `Navigator`) and use cases, `infrastructure/` adapters,
a `ui/`, and a composition root for each mount. The boundaries script's layering rule now covers it too: no Preact in
`domain/` or `application/`.

The entry the host loads is tiny:

```ts
export const contract: string = MOUNT_CONTRACT;

export const mount = (el: HTMLElement, ctx: MountContext): Unmount =>
  createMount({ css, api: (tokens) => new HttpTaxSlipsApi(apiBase(), tokens) })(el, ctx);
```

`createMount` attaches an open shadow root to `el` and puts the island's styles inside it. That keeps the island's CSS
from leaking out, and the host's CSS from leaking in. The exceptions are inherited fonts, colours and CSS custom
properties, which is what we want. To be clear, the shadow root only scopes **styles**. The island's script can still
reach `document` like any other script on the page.

Each mount also gets one `AbortController`, which `Unmount` aborts synchronously. Preact runs effect cleanups after the
next paint, and I didn't want a request from a page the citizen has already left to land after that.

### Finding and loading code you didn't compile

This is the part that needs the most care. The host is about to run JavaScript it didn't build.

The trust starts in the host's code, not in configuration. The host keeps a registry of approved remotes, and for each
one it fixes the contract's major version, the API audience and the scopes the island may be given. Only the URLs come
from configuration, and only their origins are allowed. The island's build publishes a manifest beside its one hashed
entry file:

```json
{
  "id": "cra-tax-slips",
  "contract": "app-mfe/1",
  "entry": "mount.CQsOWGlR.js",
  "integrity": "sha384-75dc/UUMp40U9yBX7sjtF7Uy243rZNhCyzB0JgHMMuNn7KqSWtEJYDOipLmBXWcR",
  "api": { "baseUrl": "api/v1/", "audience": "cra-tax-slips-api", "scopes": ["tax-slips:read"] }
}
```

On the server, the page's loader runs a `ResolveRemoteMount` use case through `run()`. It reads the manifest through
the `ManifestSource` port and treats it as untrusted input. It parses every field and checks the result against the
registry: the same contract major version, the same audience, and an entry and API on the approved origin over HTTPS.
A manifest can't approve a new origin or ask for a wider scope.

The HTTP adapter for that port lives in the composition root, not in the module, because modules don't touch the
network. It allows 1.5 seconds, refuses redirects (so a manifest can't send the host somewhere else), caps the size at
64 KB and caches a good answer for a minute.

Every way this can go wrong is a typed error, and the loader turns each one into a state the page can render:

```ts
ResolveRemoteMount('cra-tax-slips').pipe(
  Effect.map((remote): RemotePage => ({ state: 'ready', remote, basename, language })),
  Effect.catchTags({
    RemoteNotRegistered: () => unavailable('not registered'),
    RemoteUnavailable: ({ reason }) => unavailable(reason),
    ManifestInvalid: ({ reason }) => unavailable(`invalid manifest: ${reason}`),
    OriginNotApproved: ({ url }) => unavailable(`unapproved origin: ${url}`),
    RemoteIncompatible: () => incompatible(),
  }),
)
```

What reaches the browser is an entry URL and its integrity hash. There's no token and nothing secret. Server rendering
stops at the host's chrome, the heading and a loading state. The island renders in the browser.

In the browser, the host's outlet loads the entry in two steps:

```ts
// The one place in the repository allowed to import() a URL it doesn't know at build time.
await preload(entryUrl, integrity, timeoutMs); // <link rel="modulepreload" integrity="…" crossorigin>
const loaded: unknown = await import(/* @vite-ignore */ entryUrl);
if (!isRemoteModule(loaded)) throw new RemoteLoadFailed(`${entryUrl} does not export this host's mount contract`);
```

The browser checks the preloaded bytes against the hash before anything runs. If the hash doesn't match, the network
fails or the load times out, the outlet stops. **None of the island's code runs.** This is what the boundaries script's
"no dynamic code" rule protects: a non-literal `import()` is allowed in exactly this one file.

![Loading the island: the registry in code anchors trust; the manifest is checked as untrusted input; the browser verifies the entry's hash before running it; every step can refuse and fall back to the notice]({{ '/assets/images/2026-11-10-modular-monolith/island-trust-chain.svg' | relative_url }}){: .diagram style="background:none;padding:0"}

Integrity checks are easy to oversell, so here's exactly what this one covers. It stops a stale, swapped or tampered
entry file from running in place of the one the manifest names. The island's build enforces a single entry chunk, so
that hash covers all of its code. It does **not** protect against someone who controls the island's own server, because
they could change the manifest and the entry together.

One React Router detail is worth stealing. The page's descriptor doesn't change while the citizen moves around inside the
island, or when the island asks for a token. Neither should reload the loader, because that would remount the island:

```ts
export const shouldRevalidate: ShouldRevalidateFunction = ({ formAction, formMethod, currentUrl, nextUrl, defaultShouldRevalidate }) => {
  if (formAction?.startsWith(ACCESS_PREFIX) === true) return false; // a token request
  if (formMethod === undefined && currentUrl.href !== nextUrl.href) return false; // moving inside the island
  return defaultShouldRevalidate;
};
```

### The one token that reaches the browser

Earlier I wrote that tokens from the identity provider never reach the browser. That's still true, and neither does the
session. But the island's API is served by another deployment, and it needs to know who's asking. So the island gets a
different, much narrower token. It is the one documented exception to the rule.

Identity mints it. The identity module publishes a `DelegatedTokenIssuer` over a `DelegationSigner` port. The local
adapter signs with an ES256 key of its own, which isn't the session secret or the OIDC client key, and identity serves
the public half as a JWKS. The subject always comes from the request's `CurrentUser`. A caller can name only the
audience and the scopes, and the host takes those from its registry. The host reaches all this through its own
anti-corruption layer, just as jobs reaches profile.

The browser asks for a token with a React Router fetcher posting to a host route, `POST /mfe-access/:remoteId`, so the
host module still never calls `fetch` itself. That route checks, in order:

1. The method is `POST`. Otherwise it answers 405.
2. The `Origin` header is the host's own origin. Otherwise 403. This stops cross-site callers. It doesn't, and can't,
   tell the island apart from the rest of the page.
3. The body doesn't try to choose a subject, an audience or a scope. Otherwise 400.
4. A citizen is signed in. Otherwise 401, as data and not a redirect, because a script asked, not a person.
5. The citizen has consented. Otherwise 403.

Then it runs `GrantRemoteAccess` through `run()`, with the same exhaustive `onError` you saw earlier: an unknown remote
is a 404, a refusal a 403, and an unavailable signer a 503. Every answer is `Cache-Control: no-store`.

The token itself is as small as I could make it. It uses the `at+jwt` type from RFC 9068 and ES256 with a key ID. It
names one audience (the island's API) and one scope (`tax-slips:read`), and it lives for at most 120 seconds. It has a
random `jti` and no name, email, session ID or identity-provider token. It never appears in loader data, HTML, URLs, web
storage or logs. The island keeps it in a closure for one mount, reuses it until 15 seconds before it expires, and drops
it when it unmounts.

The island's API verifies the token against the host's JWKS and trusts nothing else:

```ts
const { payload } = await jwtVerify(token, keys, {
  algorithms: ['ES256'],
  typ: 'at+jwt',
  issuer,
  audience,
  clockTolerance: 5,
  requiredClaims: ['sub', 'exp', 'iat', 'scope'],
});
```

It then checks the scope and selects records by the verified subject only. Asking for another citizen's slip gets a
"not found", and there's an end-to-end test for that.

Here's what I accepted, stated plainly. This is a bearer token, not one bound to the sender. While it lives, any script
on the page can read it. It can't be revoked, so it stays valid for up to two minutes after the citizen signs out. The
alternative is a backend-for-frontend in identity that proxies the island's API. That keeps the token on the server, but
it changes the contract and puts the island's traffic through our deployment. For a proof of concept with synthetic
data, two minutes was an acceptable price. Before production it gets another look, along with whether the subject
should be a pairwise identifier per audience.

### When the island is down

The island fails like any other part of the page: in its own space. If the manifest can't be read, doesn't parse, names
an unapproved origin or speaks another major version, the page still answers 200. The chrome, the side navigation and
the language toggle all work, and the page shows a localized notice with a **Try again** button. If the entry itself
fails to load or throws while mounting, the outlet shows the same notice.

Two details make Try again actually work. A browser remembers a failed module URL for the life of the document, so a
retry adds `?attempt=N` to the URL. And a result that arrives after the citizen has left the page is never mounted.

By default the host doesn't read any manifests at all, so it boots and stays ready without the island. In that mode the
tax slips page simply shows its notice. The end-to-end tests cover the outage, the recovery, and a tampered entry that
must fail closed.

### A piece of the island on someone else's page

The island owns a whole subtree of paths, and sometimes that's more than you need. The dashboard wanted a "Latest tax
slips" tile on the account's home page, beside its own tiles for EI, jobs and payments. The tile's data, code and release
schedule are all CRA's. The page around it is the dashboard's.

So a remote can now export **fragments** as well: small pieces that a module's page shows in a slot, with no path of their
own.

Mounting one turned out to be the easy part. The hard part was the module graph. `mfe-host` publishes nothing, and that's
deliberate. The dashboard could import it without breaking a rule, but the host already depends on identity and profile.
The day profile wanted a fragment, the graph would have a cycle. Besides, a module has no business knowing about
manifests and entry URLs.

The way out is the same inversion the kernel already uses for its types. The kernel declares a slot, and the application
fills it:

```ts
/** The fragments a module's page may show, as `<remote>/<fragment>`. */
export interface RemoteFragmentRegister {
  readonly 'cra-tax-slips/latest-slips': true;
}

export type RemoteFragmentId = keyof RemoteFragmentRegister;

/** Provided by the application's signed-in layout; absent in tests and outside it. */
export const RemoteFragmentContext = createContext<ComponentType<RemoteFragmentContentProps> | undefined>(undefined);
```

The dashboard renders the kernel's `RemoteFragment` and names the fragment it wants. It owns the frame and the heading,
and it passes the translated text:

```tsx
<RemoteFragment id="cra-tax-slips/latest-slips" as="li" heading={t('home.tiles.slips.heading')} headingLevel={3} />
```

The account layout provides the host's implementation, so every `account` page gets it and nothing else does:

```tsx
<RemoteFragmentContext value={FragmentSlot}>
  <AppChrome user={loaderData.user}>{/* … */}</AppChrome>
</RemoteFragmentContext>
```

A module names a fragment. It never sees an entry URL, an integrity hash or a token. An identifier that isn't in the
register is a type error, just like a link to a page that doesn't exist. The register lives in the kernel and belongs to
the architecture group, so putting a fragment on a page is a reviewed decision. That's governance, not authorization,
though: the token route can't tell which page asked. The boundaries script has tests for both halves. Any module may
render the slot through the kernel with no new module edge, and a module that imports `mfe-host` is still refused.

Fragments are an optional addition to the remote's entry, with a protocol of their own, `app-mfe-fragment/1`:

```ts
export interface FragmentContext {
  readonly language: 'en' | 'fr';
  /** The heading level the host's frame uses, so the fragment nests below it. */
  readonly headingLevel: 2 | 3 | 4 | 5 | 6;
  getAccessToken(): Promise<string>;
  /** A host-approved destination inside the remote's own page, as an href; undefined if not approved. */
  href(destination: string): string | undefined;
  navigate(destination: string): void;
}

export interface RemoteModule {
  readonly contract: string;
  mount(el: HTMLElement, ctx: MountContext): Unmount;
  readonly fragments?: Readonly<Record<string, RemoteFragment>>;
}
```

A fragment gets less than a page does. It owns no path, so it has no `basename`, no `onLocationChange` and no free-form
`navigate`. It can only link into the remote's own page, and the host refuses anything else. The page contract stays at
`app-mfe/1`, so a page-only remote and an older host both keep working. The fragment protocol can change without forcing
every page to migrate.

The slot resolves its fragment in the browser, after hydration. Server rendering produces the frame, the heading and a
placeholder sized for the content, so the page barely shifts when the tile arrives. The dashboard's loader doesn't change
at all, which keeps a slow manifest out of the page's loader. Instead, the host's outlet asks a host resource route,
`GET /mfe-fragments/:remoteId/:fragmentId`, for a descriptor: the entry URL, its integrity hash, the protocol and a
state. Never a token. That route runs a `ResolveFragmentMount` use case through `run()`, which adds three gates to the
page's checks:

1. **The host's registry approves the fragment.** It's listed in code, next to the remote's audience and scopes, and
   it's checked before any manifest is read.
2. **The manifest declares it**, with a fragment protocol the host supports.
3. **The loaded entry exports it**, again with a supported protocol.

A manifest can't add a fragment on its own. From there, the entry loads through the same integrity-checked path as the
page. One entry exports the page and every fragment, so the single-chunk rule and its hash still cover all of the
island's code. The browser downloads that entry once, however many slots (or the page) ask for it.

A fragment gets its token from the same `POST /mfe-access/:remoteId` route, with the remote's scopes. That means its
token is exactly as powerful as the page's. That's acceptable while CRA is read-only. The registry already reserves
per-fragment scopes, checked at boot to be a subset of the remote's, for the day a remote gains a write scope. There's
one React Router change here too. On the island's own page, `shouldRevalidate` stopped a token request from re-running
loaders. On the dashboard, nothing did, so the token fetcher now submits with `defaultShouldRevalidate: false`, and a token
request re-runs no loader anywhere.

A fragment fails the way the island does, only in a smaller space. If the descriptor can't be had, the hash doesn't
match, the mount throws or the fragment's API call fails, the tile shows a localized notice with **Try again**, and the
page still answers 200. The notice doesn't announce itself as an alert or steal focus, because it's one tile on a busy
page. Signed out or without consent, the tile shows a plain message and never redirects. Even the host's outlet code is
loaded lazily, so if that download fails, only the slot notices.

Deploys needed one more piece of care. The entry's file name is a hash, so every release replaces it. A dashboard opened
before a deploy may still hold a descriptor that names the old entry. So the remote keeps serving previous releases'
entries from a retained directory, which a `retain` step fills in its release pipeline. Manifests are never served from
there. Rollouts go remote first, host second, and `MFE_FRAGMENTS=off` turns every slot off without redeploying the host.
A value that isn't valid also means off.

Finally, every response now carries a Content Security Policy in report-only mode. Its `script-src` and `connect-src`
come from the registry: `'self'` plus each approved remote's origin. It can't be enforced yet, because `'unsafe-inline'`
stays in `script-src` until server-rendered scripts carry nonces. Until then, it reports violations to a host route,
where they're logged.

### An integration boundary, not a sandbox

One last caveat, and it's the most important. Once mounted, the island runs with the host origin's privileges. It runs
in the same document, with the same cookies, the same DOM and the same token route. In the cluster, its server is even
served from the host's origin, so it's trusted as well. The mount contract is an **integration** boundary. It is not a
sandbox.

The registry, the origin allow-list, the integrity check and the Content Security Policy (report-only, for now) all stop
*unapproved* code from running. None of them stops *approved* code that turns malicious. Fragments widen that exposure:
they run third-party-built code on the account's busiest page, and they ask for tokens more often. That's why only
approved remotes from allow-listed origins are registered, and why the data is synthetic for now. A truly untrusted third
party would need an iframe and a different contract.

The island is a deliberate trade. It buys one area its own release schedule, and it pays with a run-time contract, a
token flow and a trust decision that someone has to own. That's exactly the kind of cost the rest of this post avoids,
which is why it's an exception and not a pattern.

## What we gave up, and what we got

|                              | Network boundaries                       | Boundaries in the build                    | The island (the exception)               |
| ---------------------------- | ---------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Deployables                  | one per area, plus composition           | one                                        | one more: its own build and image        |
| Moving between areas         | often a full page load                   | client-side navigation                     | client-side, through the host's router   |
| Contracts between areas      | URLs, payloads, shared session, run time | typed APIs and route keys, build time      | `mount(el, ctx)` and a manifest, run time |
| What enforces the boundaries | the network                              | package exports, a lint script, CODEOWNERS | contract version, integrity, allow-lists |
| Version skew between areas   | something you manage                     | can't happen                               | bounded: same major version only         |
| Releasing an area alone      | yes                                      | no: one release train                      | yes                                      |

The cost is real. Every team ships together, and one team's broken build blocks everyone. Being disciplined about
`main` and having a fast `check` command (typecheck, lint, boundaries, format and unit tests in one go) matter more here
than they would elsewhere. The island is the escape hatch, and the previous section showed what it costs.

What we got back is everything that tends to make split deployments expensive: no per-area platform, no session format
that several independently released apps have to agree on, no composition layer, and one developer experience. The
boundaries didn't go away. They moved somewhere cheaper to check.

This design is probably *not* right if *most* of your teams need independent release cadences. One or two areas can be
islands, but each one adds a run-time contract, a token flow and a trust decision, and a dozen of them means you want a
different architecture. It's also not right if your teams work in different languages or runtimes on the server, or
if one area needs to scale very differently from the others. In those cases the network is earning its keep.

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
- **One session, sliced** per bounded context and per tab, so modules and tabs share a sign-in without sharing state.
- **One explicit exception**, an island with its own build and a versioned mount contract, lets the one area that must
  ship alone do so without a second router, a second session or a second account. Its fragments even let it lend a
  tile to a module's page without either side importing the other.

If you take one thing from this post, I'd make it this: a boundary the compiler checks is cheaper than one the network
enforces, and usually more honest too. When a boundary really does have to move to run time, make it one explicit
exception, and write down exactly what its checks promise and what they don't.
