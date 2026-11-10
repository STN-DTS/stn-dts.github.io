---
layout: post
title: "A clean Entra ID on-behalf-of flow in Spring Boot with RestClient"
date: 2026-03-18
author: Greg Baker
categories:
- spring-boot
- java
- entra-id
- oauth2
- security
---

The OAuth 2.0 on-behalf-of (OBO) flow solves one specific problem. Your API receives a user's access token, but the
real work happens in another protected API further downstream. You can't just forward the original bearer token and
hope the next service accepts it, because that token was issued for *your* API, not the next one. With OAuth, the right
move is to exchange the incoming user token for a new access token that's issued for the downstream API.

You need this any time the user's identity has to carry across service boundaries. A gateway calls an orders API, and
the orders API calls a CRM. Or a web app calls a backend, and that backend needs to read from a secure internal data
service using the caller's delegated permissions ("delegated" means the app acts with the user's permissions, not its
own). In each case the downstream system should get a token meant for it, not a token minted for something else.

In this post I'll walk through a Spring Boot pattern that keeps the exchange logic out of your business code. The idea
is simple. Put the OBO exchange behind a customized `RestClient`, let Spring Security fetch the token, and add a small
cache so you don't hit the token endpoint on every downstream request.

## What the flow needs to do

At runtime, a request goes through these steps:

1. A user calls your API with a JWT access token.
2. Your application authenticates that token as usual.
3. A downstream client inside your API makes an HTTP call through a `RestClient`.
4. An OAuth2 interceptor asks for an access token for the downstream API.
5. A custom OBO provider takes the incoming JWT, sends it to Entra ID with `requested_token_use=on_behalf_of`, and gets
   back a new access token.
6. The `RestClient` sends the downstream request with that new token.

What I like here is where this happens. Your use case code stays boring: it calls a typed client. The typed client
knows nothing about parsing JWTs or calling token endpoints. The infrastructure layer owns that problem.

## Why `RestClient` is a good fit

You could do the OBO exchange in a service class, in a filter, or in a custom HTTP client wrapper that does everything
itself. I don't like any of those.

Putting it behind `RestClient` gives you a cleaner boundary. The application service depends on a downstream port or a
typed client. Authentication stays in the infrastructure layer. A token is only fetched when you actually make a
downstream call, and Spring Security still handles the OAuth2 protocol details.

That separation is why the pattern holds up. The domain code doesn't know what Entra ID is. The controller doesn't fetch
tokens by hand. The HTTP client doesn't contain business logic. Each layer has one job.

## How the pieces fit together

In a typical hexagonal Spring Boot app (one where business logic talks to the outside world only through interfaces
called ports), the pieces look like this:

- `OrderService`, or some other application service, calls a downstream port.
- `DownstreamApiClient` is a small infrastructure wrapper around `RestClient`.
- `OAuth2ClientHttpRequestInterceptor` gets tokens when requests leave the process.
- `DownstreamOboTokenProvider` teaches Spring Security how to do the Entra ID OBO exchange.
- `OboTokenCache` reuses exchanged tokens for the same source JWT until either token is close to expiring.

This gives you one narrow seam to test and one obvious place to put operational safeguards.

## Start with a typed `RestClient`

First, hide the raw HTTP details behind a client that represents the downstream dependency. The business layer should
call methods, not build URLs by hand.

```java
public final class DownstreamApiClient {

    private final RestClient restClient;

    public DownstreamApiClient(
            String baseUrl,
            Collection<ClientHttpRequestInterceptor> interceptors) {
        this.restClient = RestClient.builder()
            .baseUrl(baseUrl)
            .requestInterceptors(chain -> chain.addAll(interceptors))
            .build();
    }

    public List<OrderSummary> getOrdersForCustomer(String customerId) {
        return restClient.get()
            .uri(uriBuilder -> uriBuilder
              .path("/orders")
              .queryParam("customerId", customerId)
              .build())
            .retrieve()
            .body(OrderSummary.class);
    }

}
```

This is thin on purpose. It only handles HTTP wiring and turning the response into objects. It knows nothing about
Entra ID. That part comes from the interceptor you pass in.

## Wire OBO into the `RestClient`, not your service layer

The cleanest place to put all of this together is an auto-configuration or a dedicated configuration class.

```java
@ConfigurationProperties("app.downstream")
public record DownstreamApiProperties(
    String baseUrl,
    CacheProperties cache,
    OAuthProperties oauth
) {

    public record CacheProperties(Boolean enabled, Duration expirySkew, Integer maximumSize) {}
    public record OAuthProperties(String clientId, String clientSecret, String tokenUrl, String scope) {}

}

@AutoConfiguration
@EnableConfigurationProperties({ DownstreamApiProperties.class })
@ConditionalOnProperty(prefix = "app.downstream", name = "base-url")
public class DownstreamApiAutoConfiguration {

    @Bean
    protected DownstreamApiClient downstreamApiClient(
            ObjectProvider<OboTokenCache> cacheProvider,
            DownstreamApiProperties properties) {

        final var clientRegistration = ClientRegistration
            .withRegistrationId(DownstreamOboTokenProvider.CLIENT_REGISTRATION_ID)
            .clientId(requiredOauth(properties).clientId())
            .clientSecret(requiredOauth(properties).clientSecret())
            .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_POST)
            .authorizationGrantType(AuthorizationGrantType.JWT_BEARER)
            .scope(requiredOauth(properties).scope())
            .tokenUri(requiredOauth(properties).tokenUrl())
            .build();

        final var registrations = new InMemoryClientRegistrationRepository(clientRegistration);

        final var manager = new AuthorizedClientServiceOAuth2AuthorizedClientManager(
            registrations,
            new NoOpAuthorizedClientService()
        );

        manager.setAuthorizedClientProvider(
            new DownstreamOboTokenProvider(cacheProvider.getIfAvailable())
        );

        final var oauth2 = new OAuth2ClientHttpRequestInterceptor(manager);
        oauth2.setClientRegistrationIdResolver(_ -> DownstreamOboTokenProvider.CLIENT_REGISTRATION_ID);
        oauth2.setPrincipalResolver(new SecurityContextHolderPrincipalResolver());

        return new DownstreamApiClient(
            properties.baseUrl(),
            List.of(oauth2)
        );
    }

    private DownstreamApiProperties.OAuthProperties requiredOauth(DownstreamApiProperties properties) {
        final var oauth = properties.oauth();

        if (oauth == null) {
            throw new IllegalStateException(
                "Downstream OAuth properties must be configured when app.downstream.base-url is set"
            );
        }

        final var missing = new ArrayList<String>();
        addIfMissing(oauth.clientId(), "app.downstream.oauth.client-id", missing);
        addIfMissing(oauth.clientSecret(), "app.downstream.oauth.client-secret", missing);
        addIfMissing(oauth.tokenUrl(), "app.downstream.oauth.token-url", missing);
        addIfMissing(oauth.scope(), "app.downstream.oauth.scope", missing);

        if (!missing.isEmpty()) {
            throw new IllegalStateException(
                "Downstream OAuth properties must be configured. Missing or blank properties: "
                + String.join(", ", missing)
            );
        }

        return oauth;
    }

    private void addIfMissing(String value, String name, List<String> missing) {
        if (value == null || value.isBlank()) { missing.add(name); }
    }

}
```

A few details here are worth pointing out.

The client registration uses `AuthorizationGrantType.JWT_BEARER`. That's the grant type Spring Security uses for the
OBO exchange. The `SecurityContextHolderPrincipalResolver` tells the interceptor to use the currently authenticated user
for the outgoing request. And the startup validation fails fast, listing exactly which properties are missing. That
sounds minor until you're debugging a bad deployment at 4 a.m. on a Saturday night.

I also prefer the no-op authorized-client service here. OBO is driven by the current request's user token, so I want
token reuse to be explicit and limited to the dedicated OBO cache, not hidden inside a generic client store.

## Get the incoming token from the authenticated principal

After the resource server authenticates the request, the incoming JWT is already in the security context. Don't dig it
out of the request headers in your service code. Let Spring Security hand it to the authorized-client provider.

```java
public final class DownstreamOboTokenProvider implements OAuth2AuthorizedClientProvider {

    public static final String CLIENT_REGISTRATION_ID = "downstream-api";

    private final JwtBearerOAuth2AuthorizedClientProvider delegate;

    private final OboTokenCache tokenCache;

    public DownstreamOboTokenProvider(OboTokenCache tokenCache) {
        this.tokenCache = tokenCache;

        final var messageConverter = new OAuth2AccessTokenResponseHttpMessageConverter();

        final var tokenRestClient = RestClient.builder()
            .configureMessageConverters(converters -> converters.addCustomConverter(messageConverter))
            .build();

        final var responseClient = new RestClientJwtBearerTokenResponseClient();
        responseClient.setRestClient(tokenRestClient);
        responseClient.setParametersCustomizer(parameters ->
            parameters.set("requested_token_use", "on_behalf_of")
        );

        this.delegate = new JwtBearerOAuth2AuthorizedClientProvider();
        this.delegate.setAccessTokenResponseClient(responseClient);
        this.delegate.setJwtAssertionResolver(context ->
            Optional.ofNullable(context.getPrincipal())
                .filter(JwtAuthenticationToken.class::isInstance)
                .map(JwtAuthenticationToken.class::cast)
                .map(JwtAuthenticationToken::getToken)
                .orElseThrow(() -> new IllegalStateException(
                    "No JwtAuthenticationToken found in authorization context for downstream OBO exchange"
                ))
        );
    }

    @Override
    public OAuth2AuthorizedClient authorize(OAuth2AuthorizationContext context) {
        Objects.requireNonNull(context, "context cannot be null");

        if (!CLIENT_REGISTRATION_ID.equals(context.getClientRegistration().getRegistrationId())) {
            return null;
        }

        if (!(context.getPrincipal() instanceof JwtAuthenticationToken authentication)) {
            return null;
        }

        if (tokenCache != null) {
            return tokenCache.get(authentication.getToken(), () -> delegate.authorize(context));
        }

        return delegate.authorize(context);
    }

}
```

Two things make this safe to run in production.

The first is the `jwtAssertionResolver`. It makes sure the token sent in the exchange (the "assertion") comes from the
authenticated `JwtAuthenticationToken`, not from some ad hoc thread-local or request attribute. If there's no
JWT-backed principal, the flow fails with a clear error.

The second is the parameter customizer. Entra ID expects `requested_token_use=on_behalf_of` on the token request. If
you leave it out, you aren't doing OBO. You're just sending a JWT bearer token request and hoping Entra guesses what you
meant.

## What Entra ID actually receives

With this setup, the token request body looks roughly like this:

```text
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
requested_token_use=on_behalf_of
assertion=<incoming user access token>
client_id=<your confidential client id>
client_secret=<your client secret>
scope=api://downstream-api/.default
```

Each field has a job. The assertion is the original user token. The client ID and secret identify your API as the
confidential client making the exchange. The scope points at the downstream API, not the current one. And the
on-behalf-of flag tells Entra ID what kind of exchange you want.

If the downstream API permissions are wrong, or the app registrations aren't set up to trust each other, this request
fails. That's a configuration problem, not a code problem.

## Add a cache or you'll exchange too often

Without a cache, every downstream call can trigger a token exchange. It works, but it's noisy, slower than it needs to
be, and puts extra load on the token endpoint.

The cache I like is deliberately narrow. It stores exchanged authorized clients keyed by the source JWT's issuer, its
subject, and a SHA-256 fingerprint (hash) of the raw token. Each entry expires at whichever comes first: the source
JWT's expiry or the exchanged access token's expiry. A small skew is subtracted from that time before the entry counts
as reusable.

```java
public final class OboTokenCache {

    private record CacheKey(String issuer, String subject, String tokenFingerprint) {}
    private record CachedAuthorizedClient(OAuth2AuthorizedClient client, Instant expiresAt) {}

    private final Cache cache;

    private final Duration expirySkew;

    private final Clock clock;

    public OAuth2AuthorizedClient get(
            Jwt jwt,
            Supplier<OAuth2AuthorizedClient> authorizedClientProvider) {
        final var sourceExpiresAt = Optional.ofNullable(jwt.getExpiresAt())
            .orElseGet(() -> Instant.now(clock).plus(Duration.ofHours(1)));

        return cacheKey(jwt)
            .map(key -> getOrExchange(key, sourceExpiresAt, authorizedClientProvider))
            .orElseGet(authorizedClientProvider);
    }

    private OAuth2AuthorizedClient getOrExchange(
            CacheKey key,
            Instant sourceExpiresAt,
            Supplier<OAuth2AuthorizedClient> authorizedClientProvider) {
        final var now = Instant.now(clock);
        final var cached = getCachedEntry(key, now).map(CachedAuthorizedClient::client);

        if (cached.isPresent()) { return cached.get(); }

        return getCachedEntry(key, Instant.now(clock))
            .map(CachedAuthorizedClient::client)
            .orElseGet(() -> {
                final var authorizedClient = authorizedClientProvider.get();
                cacheAuthorizedClient(key, sourceExpiresAt, authorizedClient);
                return authorizedClient;
            });
    }

    private void cacheAuthorizedClient(
            CacheKey key,
            Instant sourceExpiresAt,
            OAuth2AuthorizedClient authorizedClient) {
        if (authorizedClient == null || authorizedClient.getAccessToken() == null) {
            return;
        }

        final var accessTokenExpiresAt = authorizedClient.getAccessToken().getExpiresAt();
        if (accessTokenExpiresAt == null) {
            return;
        }

        final var earliestExpiresAt = sourceExpiresAt.isBefore(accessTokenExpiresAt)
            ? sourceExpiresAt
            : accessTokenExpiresAt;

        final var effectiveExpiresAt = earliestExpiresAt.minus(expirySkew);

        if (effectiveExpiresAt.isBefore(Instant.now(clock))) {
            return;
        }

        cache.put(key, new CachedAuthorizedClient(authorizedClient, effectiveExpiresAt));
    }

    private Optional<CacheKey> cacheKey(Jwt jwt) {
        if (!StringUtils.hasText(jwt.getTokenValue())) {
            return Optional.empty();
        }

        if (!StringUtils.hasText(jwt.getSubject())) {
            return Optional.empty();
        }

        final var issuer = Optional.ofNullable(jwt.getIssuer()).map(Object::toString).orElse("");
        if (!StringUtils.hasText(issuer)) {
            return Optional.empty();
        }

        return Optional.of(new CacheKey(issuer, jwt.getSubject(), sha256(jwt.getTokenValue())));
    }

}
```

There are three practical ideas in that code.

First, the cache key includes a fingerprint of the raw incoming token. When the user's token rotates, the old cache
entry stops being used. That's what you want.

Second, the expiry is based on whichever token expires first. Once the source JWT has expired, the cached OBO token
shouldn't be reused, even if its own expiry is later.

Third, the second cache lookup right before the exchange is deliberate. It cuts down on duplicate token exchanges when
several requests arrive at the same time.

## Log enough to debug, but never log secrets

You only notice the token exchange code when it breaks, so good logging pays off. Here's what I recommend:

- Log when a provider skips authorization because the registration ID doesn't match.
- Log when the principal isn't a `JwtAuthenticationToken`.
- Log cache reuse, miss, recheck hit, exchange, expiry, and store events.
- Include stable identifiers like the issuer and subject.
- Never log the raw JWT, the access token, the client secret, or the token request body.

Get this wrong and you either have nothing to go on when production fails, or you've written exactly the material an
incident review will ask why you logged.

## Make configuration explicit

Keep the required Entra settings together and validate them at startup.

```yaml
app:
  downstream:
    base-url: https://api.example.internal
    api-key: 00000000-0000-0000-0000-000000000000
    cache:
      enabled: true
      expiry-skew: 30s
      maximum-size: 1000
    oauth:
      client-id: 00000000-0000-0000-0000-000000000000
      client-secret: 00000000-0000-0000-0000-000000000000
      token-url: https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token
      scope: api://downstream-api/User.Read.All
```

Name the properties however you like. What matters is what they mean. `client-id` and `client-secret` identify your
confidential client. `token-url` points at your tenant's Entra token endpoint. `scope` targets the downstream API. The
cache settings control how aggressively exchanged tokens get reused.

If your application makes both OBO calls and service-account calls, use separate client registrations for them, even if
they point at the same downstream API. They authenticate in different ways, and your code should make that clear.

## The service that uses the client stays simple

Once the client is wired up, your application code doesn't carry any OAuth2 boilerplate.

```java
public final class OrderService {

    private final DownstreamApiClient downstreamApiClient;

    public OrderService(DownstreamApiClient downstreamApiClient) {
        this.downstreamApiClient = Objects.requireNonNull(
            downstreamApiClient,
            "downstreamApiClient cannot be null"
        );
    }

    public List<OrderSummary> getOrdersForCustomer(String customerId) {
        return downstreamApiClient.getOrdersForCustomer(customerId);
    }

}
```

That's the payoff. The OBO flow is there, but it doesn't leak across the whole application.

## Gotchas

These are the things that usually trip people up.

### The scope must belong to the downstream API

The OBO token request isn't asking for more access to the current API. It's asking for a token for the next API. If
your scope value is wrong, the code can look perfect and still fail.

### `requested_token_use=on_behalf_of` is not optional

Spring Security gets you most of the way, but Entra ID still expects this parameter on the token request. Add it
explicitly.

### Fail fast on missing properties

Don't let the application start with a base URL and half an OAuth2 config. It's much better to crash at startup with a
message that lists the missing property names.

### Cache against both token lifetimes

If you only look at the downstream access token's expiry, you can end up reusing an exchanged token after the user's
original token should no longer be allowed through.

### Add a little expiry skew

Subtracting 30 seconds from the expiry is a cheap way to avoid failures in the middle of a request. Clock drift, thread
scheduling, or a slow network hop can otherwise catch a token right as it expires.

### Test the raw token request, not just the happy path

One of the most useful tests for this pattern checks that the token endpoint receives:

- `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
- `requested_token_use=on_behalf_of`
- the incoming JWT as `assertion`
- the expected confidential-client credentials

That test catches the kind of regression that otherwise only shows up after you deploy.

## Why I like this approach

It's strict where it matters. The business layer never touches token plumbing. The infrastructure layer only
customizes what it has to. Startup validation catches broken config early. The cache cuts down on repeated exchanges
without trying to be clever, and the logging is useful without leaking credentials.

Most of the moving parts already exist in Spring Security. The trick is knowing where to put the Entra-specific pieces
so the rest of the application stays boring. That's usually a good sign you picked the right design.

## Appendix: calling the same downstream API with a service account

Sometimes the same downstream API needs to be called in two different ways. Calls made as part of a user's request
should go through OBO, so the downstream API sees the caller's delegated identity. Calls made by the system itself
should use the client credentials flow, because there's no user involved.

This is common in real systems. A normal API request might need OBO, while a nightly reconciliation job against the
same downstream API runs as a service account. The target API is the same, but how you authenticate is not.

The clean way to model this is with two client registrations and two typed clients, even if they share a base URL.

### Add a second provider for client credentials

The service-account side is much simpler, because there's no incoming JWT to exchange.

```java
public final class ServiceAccountAuthorizedClientProvider implements OAuth2AuthorizedClientProvider {

        public static final String CLIENT_REGISTRATION_ID = "downstream-api-service-account";

        private final ClientCredentialsOAuth2AuthorizedClientProvider delegate =
            new ClientCredentialsOAuth2AuthorizedClientProvider();

        @Override
        public OAuth2AuthorizedClient authorize(OAuth2AuthorizationContext context) {
            Objects.requireNonNull(context, "context cannot be null");

            final var registrationId = context.getClientRegistration().getRegistrationId();

            if (!CLIENT_REGISTRATION_ID.equals(registrationId)) {
                    return null;
            }

            return delegate.authorize(context);
        }

}
```

There's no `JwtAuthenticationToken` requirement here because the client credentials flow isn't tied to a user. Spring
Security just needs a client registration with `AuthorizationGrantType.CLIENT_CREDENTIALS`.

### Register a second `RestClient`

Don't overload the OBO client with a second mode. Make the split explicit.

```java
@Bean
ServiceAccountDownstreamApiClient serviceAccountDownstreamApiClient(DownstreamApiProperties properties) {
    final var clientRegistration = ClientRegistration
        .withRegistrationId(ServiceAccountAuthorizedClientProvider.CLIENT_REGISTRATION_ID)
        .clientId(requiredOauth(properties).clientId())
        .clientSecret(requiredOauth(properties).clientSecret())
        .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_POST)
        .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
        .scope(requiredOauth(properties).scope())
        .tokenUri(requiredOauth(properties).tokenUrl())
        .build();

    final var registrations = new InMemoryClientRegistrationRepository(clientRegistration);

    final var manager = new AuthorizedClientServiceOAuth2AuthorizedClientManager(
        registrations,
        new InMemoryOAuth2AuthorizedClientService(registrations)
    );

    manager.setAuthorizedClientProvider(new ServiceAccountAuthorizedClientProvider());

    final var oauth2 = new OAuth2ClientHttpRequestInterceptor(manager);
    oauth2.setClientRegistrationIdResolver(_ -> ServiceAccountAuthorizedClientProvider.CLIENT_REGISTRATION_ID);

    return new ServiceAccountDownstreamApiClient(
        properties.baseUrl(),
        List.of(oauth2)
    );
}
```

This looks a lot like the OBO setup, but it differs in two important ways. The grant type is `CLIENT_CREDENTIALS`, not
`JWT_BEARER`. And the authorized-client service can be the normal in-memory one, because there's no per-user token
exchange cache to manage.

### Keep the API shape the same, not the auth path

To keep your application code readable, expose two typed clients with the same downstream operations.

```java
public final class ServiceAccountDownstreamApiClient {

    private final RestClient restClient;

    public ServiceAccountDownstreamApiClient(
            String baseUrl,
            Collection<ClientHttpRequestInterceptor> interceptors) {
        this.restClient = RestClient.builder()
            .baseUrl(baseUrl)
            .requestInterceptors(chain -> chain.addAll(interceptors))
            .build();
    }

    public List<OrderSummary> getOrdersForCustomer(String customerId) {
        return restClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/orders")
                .queryParam("customerId", customerId)
                .build())
            .retrieve()
            .body(OrderSummary.class);
    }

}
```

Yes, that duplicates a little transport code. I still prefer it. If one client acts as the user and the other acts as
a service account, I want that difference to be visible in the types and in dependency injection. It makes code reviews
easier, and it makes an accidental change in privileges much harder to miss.

### Split the configuration on purpose

If both auth modes call the same downstream API, keep the shared settings together and split the auth settings by
registration.

```yaml
app:
    downstream:
        base-url: https://api.example.internal
        obo:
            client-id: 00000000-0000-0000-0000-000000000000
            client-secret: 00000000-0000-0000-0000-000000000000
            token-url: https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token
            scope: api://downstream-api/user_impersonation
        service-account:
            client-id: FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF
            client-secret: FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF
            token-url: https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token
            scope: api://downstream-api/.default
```

Sometimes those scopes are the same and sometimes they aren't. The point isn't to force one shape on every deployment.
It's to make the difference obvious, because delegated permissions and application permissions are different security
contracts.

### Choose the client based on why the call exists

This last part is about architecture, not mechanics. If the call is part of a user's request and the downstream system
should see the user's delegated identity, use the OBO client. If it's a background job, a scheduled sync, or some other
system-to-system action, use the service-account client.

Don't pick based on convenience. Pick based on who the downstream API should see as the caller. If the answer is "the
user," use OBO. If it's "this application," use client credentials.
