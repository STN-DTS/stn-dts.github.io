---
layout: post
title: Decoupling components with asynchronous events in Spring Boot
author: Greg Baker
date: 2025-09-26
categories: spring-boot java backend
---

We all want code that's easy to change and keeps working as the app grows. One way to get there is *loose coupling*:
keeping the parts of the system from depending on each other more than they need to. In a Spring Boot app, the built-in
application event system is one of the best tools for this.

If you also run those events asynchronously (in the background, on another thread), you can make your API respond faster
too. In this post I'll show how, using a common example: the work that needs to happen after a new user profile is
created.

## The problem

Say we have a `ProfileService` that creates user profiles. After it saves a new profile to the database, it also has to:

- Log an audit event.
- Send a welcome email.
- Update a search index.
- Notify other internal systems.

The first version usually looks something like this:

```java
@Service
public class ProfileService {

    // ... dependencies for DB, email, audit, etc.

    public ProfileEntity createProfile(ProfileCreationRequest request) {
        // 1. Core logic: create and save the profile
        ProfileEntity newProfile = new ProfileEntity(request.getName(), request.getEmail());
        profileRepository.save(newProfile);

        // 2. Secondary, coupled logic
        auditService.logProfileCreation(newProfile); // Can this fail?
        emailService.sendWelcomeEmail(newProfile);   // Is this slow?
        searchService.indexProfile(newProfile);      // What if this is down?

        return newProfile;
    }

}
```

This works, but it has a few problems. The `createProfile` method is supposed to create a profile, and now it's also
responsible for auditing, email, and search. That breaks the single responsibility principle (the idea that each class
or method should have one job). It's also fragile: if any of the extra tasks fails, like sending the email, the whole
operation can fail with it. And it's slow. If sending an email takes a while, the user who just created their profile
waits for it before they get a response, even though they don't care about any of this extra work.

## Using application events

Spring's application events are based on the Observer pattern. One component, the *publisher*, announces that something
happened. Any number of other components, the *listeners*, get notified and react to it. The publisher doesn't know or
care who's listening. That's what lets us separate the main action (creating a profile) from the side tasks (auditing,
sending emails, and so on).

### Step 1: create an event

An event is a small class that holds the data about what happened. It's a good idea to make events immutable (they can't
be changed after they're created), and a Java `record` is a simple way to do that.

```java
// ProfileCreateEvent.java
import java.time.Instant;

/**
 * Event that is published when a profile is created.
 */
public record ProfileCreateEvent(ProfileEntity entity, Instant timestamp) {

    public ProfileCreateEvent(ProfileEntity entity) {
        this(entity, Instant.now());
    }

}
```

This event holds the newly created `ProfileEntity` and a timestamp.

### Step 2: publish the event

In `ProfileService`, we inject Spring's `ApplicationEventPublisher` and use it to publish the event.

```java
// ProfileService.java
@Service
public class ProfileService {

    private final ApplicationEventPublisher eventPublisher;
    private final ProfileRepository profileRepository;

    public ProfileService(ApplicationEventPublisher eventPublisher, ProfileRepository profileRepository) {
        this.eventPublisher = eventPublisher;
        this.profileRepository = profileRepository;
    }

    @Transactional
    public ProfileEntity createProfile(ProfileCreationRequest request) {
        // Core logic remains the same
        ProfileEntity newProfile = new ProfileEntity(request.getName(), request.getEmail());
        profileRepository.save(newProfile);

        // Publish an event instead of calling services directly
        eventPublisher.publishEvent(new ProfileCreateEvent(newProfile));

        return newProfile;
    }

}
```

The service is much simpler now. Its only job is creating the profile.

### Step 3: create listeners

Next, we write the components that react to `ProfileCreateEvent`. A listener is just a Spring bean with a method
annotated with `@EventListener`.

```java
// ProfileEventListener.java
@Component
public class ProfileEventListener {

    private final AuditService auditService;
    private final NotificationService notificationService;

    // ... constructor injection

    @EventListener
    public void handleProfileCreatedForAudit(ProfileCreateEvent event) {
        auditService.logProfileCreation(event.entity());
        // This listener only cares about auditing
    }

    @EventListener
    public void handleProfileCreatedForNotification(ProfileCreateEvent event) {
        notificationService.sendWelcomeEmail(event.entity());
        // This listener only cares about sending emails
    }

}
```

You can have as many listeners for the same event as you like, and each one handles a single concern. Auditing code
lives in one place, email code in another, and neither one is mixed into the profile service.

### Step 4: make it asynchronous

There's a catch. By default, Spring runs event listeners **synchronously**, on the same thread as the publisher. So
`ProfileService` still waits for every listener to finish before it returns, and we haven't fixed the slow response yet.

To run the listeners in the background, we need two annotations:

1. **`@EnableAsync`:**
   Add this to a configuration class to turn on asynchronous processing in your application.

    ```java
    // AsyncConfig.java
    @EnableAsync
    @Configuration
    public class AsyncConfig {
        // You can optionally configure the thread pool here
    }
    ```

2. **`@Async`:**
   Add this to your listener methods.

    ```java
    // ProfileEventListener.java
    @Component
    public class ProfileEventListener {
        // ...

        @Async
        @EventListener
        public void handleProfileCreatedForAudit(ProfileCreateEvent event) {
            // ...
        }

        @Async
        @EventListener
        public void handleProfileCreatedForNotification(ProfileCreateEvent event) {
            // ...
        }

    }
    ```

Now when `ProfileService` publishes an event, Spring hands the listener methods to a background thread pool to run.
`createProfile` returns right away without waiting for them, so the API responds faster.

## What we get out of it

`ProfileService` no longer knows anything about auditing or notifications. We can add, remove, or change listeners
without touching the service class.

The request thread is freed up right away, so API responses come back sooner.

Failures are contained. By default, an exception in one `@Async` listener won't affect the publisher or the other
listeners.

It can scale. You can configure a dedicated thread pool for async tasks, so heavy load on them doesn't eat into the
threads the rest of the app is using.

It's easier to test. You can test `ProfileService` and each listener on their own: check that the service publishes the
right event, and that each listener does the right thing when it receives one.

## Wrapping up

Asynchronous events in Spring are a good way to keep your services small and your API fast. You separate "what happened"
from "what to do about it," and the code gets easier to maintain as it grows. The next time a service method starts
picking up a pile of side tasks, think about whether an application event would be a better fit.
