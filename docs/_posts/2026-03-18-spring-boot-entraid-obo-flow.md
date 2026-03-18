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

The OAuth 2.0 on-behalf-of flow solves a very specific problem: your API
receives a user token, but the real work happens in another protected API
further downstream. You cannot just forward the original bearer token and hope
the next service accepts it. When using OAuth, the right move is to exchange
that incoming user token for a new access token that is scoped for the
downstream API.

That matters any time you need to preserve user identity across service
boundaries. A gateway calls an orders API. The orders API calls a CRM. A web app
calls a backend, and that backend needs to read a secure internal data service
using the caller's delegated permissions. The downstream system should see a
token meant for it, not a token minted for something else.

This post walks through a Spring Boot pattern that keeps that exchange logic out
of your business code. The core idea is simple: put the OBO exchange behind a
customized `RestClient`, let Spring Security perform the token acquisition, and
add a small cache so you do not hit the token endpoint on every downstream
request.

## What the flow needs to do

At runtime, the request path looks like this:

1. A user calls your API with a JWT access token.
2. Your application authenticates that token as usual.
3. A downstream client within your API issues an HTTP call through a
  `RestClient`.
4. An OAuth2 interceptor asks for an access token for the downstream API.
5. A custom OBO provider takes the incoming JWT, sends it to Entra ID with
   `requested_token_use=on_behalf_of`, and gets back a new access token.
6. The `RestClient` sends the downstream request with that new token.

The nice part is where this happens. Your use case code stays boring. It calls a
typed client. The typed client knows nothing about JWT parsing or token
endpoints. The infrastructure layer owns that problem.

## Why `RestClient` is a good fit here

You can implement OBO in a service class, or inside a filter, or with a custom
HTTP client wrapper that does everything itself. I don't like any of those.

Putting the flow behind `RestClient` has a cleaner boundary:

- The application service depends on a downstream port or typed client.
- Authentication stays in infrastructure.
- Token acquisition happens only when you actually make a downstream call.
- Spring Security still owns the OAuth2 protocol details.

That separation is what makes the pattern hold up. The domain code does not know
what Entra ID is. The controller does not manually fetch tokens. The transport
client does not need business logic. Each layer gets one job.

## The architecture in one slice

For a typical hexagonal Spring Boot application, the pieces look like this:

- `OrderService` or another application service calls a downstream port.
- `DownstreamApiClient` is a small infrastructure wrapper around `RestClient`.
- `OAuth2ClientHttpRequestInterceptor` acquires tokens when requests leave the
  process.
- `DownstreamOboTokenProvider` teaches Spring Security how to perform the Entra
  ID OBO exchange.
- `OboTokenCache` reuses exchanged tokens for the same source JWT until either
  token is close to expiry.

That arrangement gives you a narrow seam for testing and a clear place to put
operational safeguards.

## Start with a typed `RestClient`

The first step is to hide raw HTTP details behind a client that represents the
downstream dependency. The business layer should call methods, not hand-build
URLs.

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

That is deliberately thin. It owns only the HTTP wiring and response
deserialization. It does not know anything about Entra ID. That comes from the
interceptor you inject into it.

## Wire OBO into the `RestClient`, not into your service layer

The cleanest place to assemble the flow is auto-configuration or a dedicated
configuration class.

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

There are a few details here worth calling out.

First, the client registration uses `AuthorizationGrantType.JWT_BEARER`. That
is the grant Spring Security uses for the OBO exchange. Second, the
`SecurityContextHolderPrincipalResolver` means the interceptor will use the
currently authenticated principal for the outgoing request. Third, the startup
validation fails fast with the exact missing properties. That sounds small until
you debug a bad deployment at 4 a.m. on a Saturday night.

I also prefer the no-op authorized-client service in this setup. OBO is driven
by the current request's user token, so I want reuse to be explicit and scoped
to the dedicated OBO cache rather than hidden inside a generic client store.

## Retrieve the incoming token from the authenticated principal

The incoming JWT is already in the security context after resource-server
authentication. Do not fish it out of headers in your service code. Let Spring
Security hand it to the authorized-client provider.

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

Two things make this production-worthy.

The first is the `jwtAssertionResolver`. It forces the assertion used in the
token exchange to come from the authenticated `JwtAuthenticationToken`, not from
some ad hoc thread-local or request attribute. If there is no JWT-backed
principal, the flow fails clearly.

The second is the parameter customizer. Entra ID expects
`requested_token_use=on_behalf_of` on the token request. If you skip that,
you are not doing OBO. You are just sending a JWT bearer token request and
hoping Entra guesses your intent.

## What Entra ID actually receives

The request body generated by this setup ends up looking roughly like this:

```text
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
requested_token_use=on_behalf_of
assertion=<incoming user access token>
client_id=<your confidential client id>
client_secret=<your client secret>
scope=api://downstream-api/.default
```

That combination is the heart of the flow.

- The assertion is the original user token.
- The confidential client credentials identify your API as the caller making
  the exchange.
- The scope targets the downstream API, not the current API.
- The on-behalf-of flag tells Entra ID what kind of exchange you want.

If the downstream API permissions are wrong, or the app registration trust chain
is incomplete, this request fails. That is a configuration problem, not a code
problem.

## Add a cache or you will exchange too often

Without a cache, every downstream call may trigger a token exchange. That works,
but it is noisy, slower than it needs to be, and harder on your token endpoint.

The implementation I like is intentionally narrow. Cache exchanged authorized
clients by the source JWT's issuer, subject, and a SHA-256 fingerprint of the
raw token. Then expire the cache entry at the earlier of:

- the source JWT expiry
- the exchanged access-token expiry

and subtract a small skew before you consider the entry reusable.

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

There are three practical ideas buried in that code.

First, the cache key includes a fingerprint of the raw incoming token. If the
user token rotates, the cache entry is no longer reused. That is exactly what
you want.

Second, the effective expiry is based on the earlier of the source token and the
downstream token. If the source JWT is gone, the cached OBO token should not be
reused even if its own expiry is later.

Third, the second cache lookup before exchange is not accidental. It reduces
duplicate token exchanges when several requests arrive at the same time.

## Log enough to debug, but never log secrets

The token exchange path is the sort of code you only notice when it breaks. Good
logging matters.

The pattern I recommend is:

- Log when a provider skips authorization because the registration ID does not
  match.
- Log when the principal is not a `JwtAuthenticationToken`.
- Log cache reuse, miss, recheck hit, exchange, expiry, and store events.
- Include stable identifiers like issuer and subject.
- Never log the raw JWT, access token, client secret, or token request body.

If you get this wrong, you either have no signal during production failures or
you leak exactly the material an incident review will ask why you wrote to logs.

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

You can shape the property names however you like. The important part is the
contract:

- `client-id` and `client-secret` identify your confidential client.
- `token-url` points at the tenant-specific Entra token endpoint.
- `scope` targets the downstream API.
- cache settings control how aggressively you reuse exchanged tokens.

If your application supports both OBO and service-account calls, keep those as
separate client registrations even if they point at the same downstream API.
The authentication model is different. Your code should say so.

## A service that uses the client stays simple

Once the client is wired, application code does not carry any OAuth2 ceremony.

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

That is the payoff. The OBO flow exists, but it is not leaking across the whole
application.

## Gotchas that are easy to miss

These are the things that usually bite people.

### The scope must belong to the downstream API

The OBO token request is not asking for more of the current API's audience. It
is asking for a token for the next API. If your scope value is wrong, the code
can look perfect and still fail.

### `requested_token_use=on_behalf_of` is not optional

Spring Security gets you most of the way there, but Entra ID still expects that
parameter on the token request. Add it explicitly.

### Fail fast on missing properties

Do not let the application start with a base URL and half an OAuth2 config. It
is much better to crash during startup with a message listing the missing
property names.

### Cache against both token lifetimes

If you only honor the downstream access-token expiry, you can accidentally reuse
an exchanged token after the source user token should no longer authorize the
request path.

### Add a little expiry skew

Subtracting 30 seconds from the effective expiry is a cheap way to avoid
mid-flight failures caused by clock drift, thread scheduling, or a slow network
hop right when a token is about to die.

### Test the raw token request, not just the happy path

One of the most useful tests for this pattern is asserting that the token
endpoint receives:

- `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
- `requested_token_use=on_behalf_of`
- the incoming JWT as `assertion`
- the expected confidential-client credentials

That test catches the exact sort of regression that otherwise shows up only when
you deploy.

## What makes this pattern robust

I like this approach because it is strict in the places that matter.

- The business layer never touches token plumbing.
- The infrastructure layer does the minimum necessary customization.
- Startup validation catches broken config early.
- The cache reduces exchange churn without getting clever.
- Logging is useful without turning into a credential leak.

Most of the moving parts already exist in Spring Security. The trick is knowing
where to put the Entra-specific pieces so the rest of the application stays
boring.

That is usually a good sign you picked the right design.

## Appendix: using the same downstream API with a service account

Sometimes the same downstream API needs two access patterns.

- User-context calls should run through OBO so the downstream API sees the
  caller's delegated identity.
- System-context calls should use client credentials because there is no user in
  the loop.

That is common in real systems. A synchronous API request might need OBO, while
the nightly reconciliation job against the same downstream API should run as a
service account. The target API is the same. The authentication model is not.

The clean way to model that is to keep two client registrations and two typed
clients, even if they share the same base URL.

### Add a second provider for client credentials

The service-account side is much simpler because there is no incoming JWT to
exchange.

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

There is no `JwtAuthenticationToken` requirement here because the client
credentials flow is not tied to a user principal. Spring Security just needs a
client registration with `AuthorizationGrantType.CLIENT_CREDENTIALS`.

### Register a second `RestClient`

The important thing is not to overload the OBO client with a second mode. Make
the split explicit.

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

This mirrors the OBO setup closely, but the behavior is different in two
important ways.

- The grant type is `CLIENT_CREDENTIALS`, not `JWT_BEARER`.
- The authorized-client service can be the normal in-memory implementation
  because there is no per-user token-exchange cache to control.

### Keep the API shape the same, not the auth path

The easiest way to keep your application code readable is to expose two typed
clients with the same downstream operations.

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

Yes, that duplicates a little transport code. I still prefer it. If one client
is user-scoped and the other is service-account scoped, I want that distinction
visible in the type system and in dependency injection. It makes reviews easier.
It also makes accidental privilege changes much harder to miss.

### Split the configuration on purpose

If both auth modes hit the same downstream API, keep the shared transport
settings together and split the auth settings by registration.

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

Sometimes those scopes are the same. Sometimes they are not. The point is not
to force one shape on every deployment. The point is to make the distinction
obvious, because delegated and application permissions are different security
contracts.

### Choose the client based on why the call exists

That last part is architectural, not mechanical.

- If the call is part of a user request and the downstream system should see the
  user's delegated identity, use the OBO client.
- If the call is a background job, scheduled sync, or system-to-system action,
  use the service-account client.

Do not decide based on convenience. Decide based on who should be represented to
the downstream API. If the answer is "the user," use OBO. If the answer is
"this application," use client credentials.
