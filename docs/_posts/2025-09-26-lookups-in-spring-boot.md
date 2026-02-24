---
layout: post
title: A quick guide to handling code tables in Spring Boot
author: Greg Baker
date: 2025-09-26
categories: spring-boot java backend
---

Managing lookup tables (or "code tables") is a common task in API development.
These tables store values that rarely change, like statuses, types, or
categories. While they may seem simple, handling them efficiently and cleanly is
crucial for a maintainable and robust application.

In this post, we'll explore a powerful and elegant approach to managing lookup
tables in a Spring Boot application, drawing inspiration from a real-world
project. We'll see how to externalize codes to `application.yaml`, load them
with `@ConfigurationProperties`, and use them in our services to interact with
the database.

## The goal

Our goal is to create a system where:

- Lookup codes (like "APPROVED", "PENDING", etc.) are not hardcoded in our business logic.
- These codes are easily configurable without changing the Java code.
- The code is readable, type-safe, and easy to maintain.

## The solution

Let's walk through the implementation, from the database to the service layer.

### 1. The database and JPA entity

Our lookup tables are simple. For example, a `PROFILE_STATUS` table might look like this:

<div style="overflow-x: auto;" markdown="1">


| ID  | CODE       | NAME_EN    | NAME_FR    |
| --- | ---------- | ---------- | ---------- |
| 1   | APPROVED   | Approved   | Approuvé   |
| 2   | PENDING    | Pending    | En attente |
| 3   | INCOMPLETE | Incomplete | Incomplet  |
| 4   | ARCHIVED   | Archived   | Archivé    |

</div>

We represent this with a JPA entity. We can use a base class like
`AbstractCodeEntity` to hold common fields.

```java
// AbstractCodeEntity.java
@MappedSuperclass
public abstract class AbstractCodeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "CODE", nullable = false, unique = true)
    private String code;

    // ... other fields like nameEn, nameFr, createdDate, etc.

}
```

And the specific entity for our profile statuses:

```java
// ProfileStatusEntity.java
@Entity(name = "ProfileStatus")
@Table(name = "[PROFILE_STATUS]")
public class ProfileStatusEntity extends AbstractCodeEntity {
    // ... constructors and builders
}
```

### 2. Externalize codes in `application.yaml`

Instead of hardcoding strings like "APPROVED" in our code, we'll define them in
`application.yaml`. This makes them easy to find and change.

```yaml
# application.yaml
codes:
  profile-statuses:
    approved: APPROVED
    archived: ARCHIVED
    incomplete: INCOMPLETE
    pending: PENDING
  # ... other lookup codes
```

### 3. The `@ConfigurationProperties` class

Now, we need a way to load these values into our Spring application. A
`@ConfigurationProperties` class is perfect for this. We'll use a Java `record`
for an immutable, concise representation.

```java
// LookupCodes.java
@Validated
@ConfigurationProperties("codes")
public record LookupCodes(
    @NestedConfigurationProperty ProfileStatuses profileStatuses,
    // ... other nested properties for other code types
) {

    @Validated
    public record ProfileStatuses(
        @NotBlank String approved,
        @NotBlank String archived,
        @NotBlank String incomplete,
        @NotBlank String pending
    ) {}

}
```

To make this work, we need to enable it in our main application class:

```java
// Application.java
@SpringBootApplication
@EnableConfigurationProperties({ LookupCodes.class })
public class Application {
    // ...
}
```

### 4. The repository

We need a repository to fetch our lookup entities from the database. A simple
Spring Data JPA repository will do. We can define a method to find a code entity
by its `code` string.

```java
// AbstractCodeRepository.java
@NoRepositoryBean
public interface AbstractCodeRepository<T extends AbstractCodeEntity> extends JpaRepository<T, Long> {
    Optional<T> findByCode(String code);
}

// ProfileStatusRepository.java
@Repository
public interface ProfileStatusRepository extends AbstractCodeRepository<ProfileStatusEntity> {}
```

### 5. The service layer: putting it all together

This is where the magic happens. Our `ProfileService` will inject both the
`LookupCodes` and the `ProfileStatusRepository`.

When we need to set a profile's status, we can use our `LookupCodes` object to
get the code string, and the repository to fetch the corresponding entity.

```java
// ProfileService.java
@Service
public class ProfileService {

    private final ProfileRepository profileRepository;
    private final ProfileStatuses profileStatuses;
    private final ProfileStatusRepository profileStatusRepository;

    public ProfileService(
            LookupCodes lookupCodes,
            ProfileRepository profileRepository,
            ProfileStatusRepository profileStatusRepository) {
        this.profileRepository = profileRepository;
        this.profileStatuses = lookupCodes.profileStatuses();
        this.profileStatusRepository = profileStatusRepository;
    }

    @Transactional
    public ProfileEntity createProfile(ProfileEntity profile) {
        // 1. Get the code string from our type-safe config object
        String incompleteStatusCode = profileStatuses.incomplete();

        // 2. Use the code to find the entity in the database
        ProfileStatusEntity incompleteStatus = profileStatusRepository.findByCode(incompleteStatusCode)
            .orElseThrow(() -> new IllegalStateException("INCOMPLETE status not found"));

        // 3. Set the status on our new profile
        profile.setProfileStatus(incompleteStatus);

        return profileRepository.save(profile);
    }
}
```

## Benefits of this approach

- **Decoupling:**
  The business logic in `ProfileService` is no longer coupled to the raw string
  "INCOMPLETE". It uses a symbolic name (`profileStatuses.incomplete()`).
- **Configuration over Code:**
  If a status code ever needs to change (e.g., from "INCOMPLETE" to "DRAFT"),
  you only need to update `application.yaml`. No Java code changes are required.
- **Readability and Maintainability:**
  The code is much cleaner and easier to understand. It's clear that we're
  setting the profile to an "incomplete" status.
- **Type Safety:**
  Using a `record` for our configuration properties gives us compile-time safety
  and autocompletion in our IDE.

## Conclusion

By combining the power of Spring Boot's `@ConfigurationProperties` with a clean
service layer design, we can handle lookup tables in a way that is robust,
maintainable, and a pleasure to work with. This approach keeps our code clean
and our configuration externalized, leading to a more professional and scalable
application.
