---
layout: post
title: Decoupling components with asynchronous events in Spring Boot
author: Greg Baker
date: 2025-09-26
categories: spring-boot java backend
---

As software engineers, we strive to write code that is clean, maintainable, and
scalable. A key principle to achieve this is loose coupling: reducing the
dependencies between different parts of our system. In a Spring Boot
application, one of the most powerful tools for decoupling is the application
event system.

When you combine events with asynchronous execution, you can unlock significant
improvements in performance and responsiveness. Let's dive into how you can use
this pattern to decouple components, illustrated with a common use case:
handling tasks after a new user profile is created.

## The problem: tightly coupled logic

Imagine a `ProfileService` that creates a user profile. After saving the new
profile to the database, it needs to perform several other tasks:
- Log an audit event.
- Send a welcome email.
- Update a search index.
- Notify other internal systems.

A naive implementation might look like this:

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

This approach has several drawbacks:
- **Violation of single responsibility principle:**
  The `createProfile` method is doing more than just creating a profile.
- **Brittleness:**
  A failure in any of the secondary tasks (like sending an email) could cause
  the entire operation to fail.
- **Poor performance:**
  If sending an email is slow, it will delay the HTTP response to the user who
  just created their profile. The user is stuck waiting for tasks they don't
  need to be aware of.

## The solution: application events

Spring's application event mechanism, based on the Observer pattern, allows us
to decouple the primary action (creating a profile) from the secondary actions
(auditing, sending emails).

The flow is simple:
1. A component (the **publisher**) publishes an event.
2. One or more other components (the **listeners**) are notified and react to
   that event.

Crucially, the publisher doesn't know or care who is listening. It just
announces that something happened.

### Step 1: create a custom event

An event is a simple class that holds the data relevant to what happened. It's
good practice to make these immutable. Using a Java `record` is perfect for
this.

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

This event captures the newly created `ProfileEntity` and a timestamp.

### Step 2: publish the event

In our `ProfileService`, we inject Spring's `ApplicationEventPublisher` and use
it to publish our new event.

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

Our service is now much cleaner. Its sole responsibility is to handle the
profile creation logic.

### Step 3: create listeners

Now, we create separate components that listen for the `ProfileCreateEvent`. A
listener is just a Spring bean with a method annotated with `@EventListener`.

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

We can have multiple listeners for the same event, each handling a different
concern. This is a huge win for separation of concerns.

### Step 4: making it asynchronous

By default, Spring event listeners run **synchronously** in the same thread as
the publisher. This means our `ProfileService` will still wait for all listeners
to finish before returning. We haven't solved the performance problem yet.

To fix this, we can make our listeners asynchronous with two simple annotations:

1. **`@EnableAsync`:**
   Add this to a configuration class to enable asynchronous processing in your
   application.

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

Now, when `ProfileService` publishes an event, Spring will submit the listener
methods to a background thread pool for execution. The `createProfile` method
will return immediately without waiting, making your API feel much faster.

## Benefits of asynchronous events

1. **Decoupling:**
   The `ProfileService` has no knowledge of the auditing or notification logic.
   You can add, remove, or change listeners without ever touching the service
   class.
1. **Improved performance & responsiveness:**
   The main thread is freed up immediately, leading to faster API response
   times.
1. **Resilience:**
   By default, an exception in one `@Async` listener will not affect the
   publisher or other listeners.
1. **Scalability:**
   You can configure a dedicated thread pool for your async tasks to handle high
   loads without impacting the main application threads.
1. **Testability:**
   You can test the `ProfileService` and its listeners in isolation, verifying
   that the service publishes the correct event and that the listeners react to
   it appropriately.

## Conclusion

Spring's asynchronous event system is a powerful pattern for building clean,
decoupled, and high-performance applications. By separating the "what happened"
from the "what to do when it happens," you create a more maintainable and
scalable architecture. The next time you find a service method getting bloated
with secondary responsibilities, consider if an application event might be a
better approach.
