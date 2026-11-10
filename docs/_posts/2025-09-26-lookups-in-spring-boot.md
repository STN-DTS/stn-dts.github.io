---
layout: post
title: A quick guide to handling code tables in Spring Boot
author: Greg Baker
date: 2025-09-26
categories: spring-boot java backend
---

Most APIs have a few lookup tables, sometimes called *code tables*. They hold values that rarely change, like statuses,
types, or categories. They look simple, but if you handle them carelessly you end up with magic strings scattered all
over your business logic.

In this post I'll show the approach we use in a real Spring Boot project. We put the codes in `application.yaml`, load
them with `@ConfigurationProperties`, and use them in our services to look up the matching rows in the database.

## What we want

We're aiming for three things. Lookup codes like "APPROVED" or "PENDING" shouldn't be hardcoded in business logic. We
should be able to change them without touching Java code. And the result should be readable, type-safe, and easy to
maintain.

Let's go through it from the database up to the service layer.

## The database and JPA entity

Our lookup tables are simple. For example, a `PROFILE_STATUS` table might look like this:

<div style="overflow-x: auto;" markdown="1">


| ID  | CODE       | NAME_EN    | NAME_FR    |
| --- | ---------- | ---------- | ---------- |
| 1   | APPROVED   | Approved   | Approuvé   |
| 2   | PENDING    | Pending    | En attente |
| 3   | INCOMPLETE | Incomplete | Incomplet  |
| 4   | ARCHIVED   | Archived   | Archivé    |

</div>

We map this to a JPA entity. Since every code table has the same basic columns, we put the shared fields in a base class
called `AbstractCodeEntity`.

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

Then the entity for profile statuses just extends it:

```java
// ProfileStatusEntity.java
@Entity(name = "ProfileStatus")
@Table(name = "[PROFILE_STATUS]")
public class ProfileStatusEntity extends AbstractCodeEntity {
    // ... constructors and builders
}
```

## Putting the codes in `application.yaml`

Instead of hardcoding strings like "APPROVED" in the Java code, we define them in `application.yaml`. That puts them all
in one place where they're easy to find and change.

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

## Loading them with `@ConfigurationProperties`

Next we need to get those values into the application. `@ConfigurationProperties` tells Spring to bind a section of the
config file (here, everything under `codes`) to a Java object. We use a Java `record` so the object is immutable and
short to write.

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

The `@Validated` and `@NotBlank` annotations tell Spring to check these values when it loads the config. With a Bean
Validation library on the classpath (such as `spring-boot-starter-validation`), the app fails at startup if a code is
missing, instead of failing later at runtime.

For Spring to pick up the class, we enable it in the main application class:

```java
// Application.java
@SpringBootApplication
@EnableConfigurationProperties({ LookupCodes.class })
public class Application {
    // ...
}
```

## The repository

To fetch lookup entities from the database, a plain Spring Data JPA repository is enough. We add a method that finds an
entity by its `code` string. Putting it in a shared base interface means every code table repository gets it for free.

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

## Using it in the service

Now we can put the pieces together. `ProfileService` injects both `LookupCodes` and `ProfileStatusRepository`. When it
needs to set a profile's status, it gets the code string from `LookupCodes`, then uses the repository to fetch the
matching entity.

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

## Why we like this

The business logic in `ProfileService` no longer depends on the raw string "INCOMPLETE". It uses a named accessor,
`profileStatuses.incomplete()`, instead.

If a status code ever has to change (say, from "INCOMPLETE" to "DRAFT"), you only update `application.yaml`. No Java
code changes are needed.

The code is easier to read. It's obvious that we're setting the profile to an "incomplete" status.

It's also type-safe. Because the config is a `record`, you call methods like `profileStatuses.incomplete()` instead of
passing strings around, so the compiler catches a mistyped method name and your IDE can autocomplete them.

## Wrapping up

Pairing `@ConfigurationProperties` with a simple service layer is a tidy way to handle lookup tables in Spring Boot. The
codes live in configuration instead of being scattered through the code, and the services that use them stay short and
easy to follow.
