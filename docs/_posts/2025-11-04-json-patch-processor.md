---
layout: post
title: Safe, validated JSON Patch processing in Spring
author: Greg Baker
date: 2025-11-04
categories: api rest json-patch
---

## Introduction

When you accept HTTP PATCH requests that update domain objects, you need a
predictable, safe way to apply partial updates while keeping your invariants
intact.

This post presents a pragmatic approach: apply an RFC-compliant JSON Patch or
JSON Merge Patch to a deep copy of the target object, validate the patched copy,
and only persist the result if it passes validation. The approach is simple,
standards-driven, and keeps validation logic in a single place.

Below I explain what the processor does, why this design is practical, important
caveats to consider, testing suggestions, and low-risk improvements. The full
implementation appears at the end of the post and is referenced from the
sections below.

## What the processor does (summary)

- **Inputs:** a Java domain object instance and a patch document (`JsonPatch` or
  `JsonMergePatch`).
- **Behavior:** serialize the object to JSON, apply the patch to the JSON, then
  deserialize the patched JSON back to a new object instance (a deep copy).
- **Validation:** validate the patched object using Jakarta Bean Validation
  (`Validator`).
- **Outputs:** return the patched instance if validation succeeds; otherwise
  throw `ConstraintViolationException`. JSON parsing or patch application errors
  are surfaced as `JsonPatchException`.

## Why this design works

This approach balances simplicity, correctness, and standards compliance:

- **Deep copy safety:** serializing then deserializing produces a separate
  object instance, avoiding accidental mutation of the original.
- **Standards-first:** using RFC 6902 / 7396 implementations means you don't
  reimplement patch semantics.
- **Central validation:** running full-object validation on the patched copy
  enforces invariants consistently and reduces duplication of validation logic
  in controllers.

The trade-offs with this approach are that the method performs serialization and
deserialization for each patch operation, so benchmark if you expect very high
throughput or very large payloads.

## Implementation highlights

The example `JsonPatchProcessor` included at the end of this post implements
these behaviors:

- **Serialization:** uses Jackson's `ObjectMapper` to convert domain objects to
  and from JSON.
- **Patch application:** uses Jakarta JSON (`jakarta.json`) to read the
  serialized JSON and apply `JsonPatch` (RFC 6902) or `JsonMergePatch` (RFC
  7396).
- **Validation:** runs Jakarta Bean Validation (`Validator`) against the patched
  instance and throws `ConstraintViolationException` for any violations.
- **Error handling:** wraps JSON or Jackson processing errors in a
  `JsonPatchException` so controllers can translate them to suitable HTTP
  responses.

Error contract summary:

- `ConstraintViolationException` — JSON parsing or patch application errors (map
  to HTTP 400).
- `JsonPatchException` — validation failures (map to HTTP 422 with field-level
  messages).

## Usage

To use the processor from a Spring controller, inject the component and pass the
existing domain object plus the parsed patch document. For example, a
merge-patch endpoint might look like this:

```java
@PatchMapping(path = "/users/{id}", consumes = "application/merge-patch+json")
public ResponseEntity<User> patchUser(@PathVariable Long id, @RequestBody JsonMergePatch mergePatch) {
	final var existing = userService.findById(id);
	final var patched = jsonPatchProcessor.patch(existing, mergePatch);
	final var saved = userService.save(patched);
	return ResponseEntity.ok(saved);
}
```

Example payloads (for reference):

- JSON Merge Patch (RFC 7396):

```json
{
  "email": "new.email@example.com",
  "profile": { "displayName": "New Name" }
}
```

- JSON Patch (RFC 6902):

```json
[
  { "op": "replace", "path": "/email", "value": "new.email@example.com" },
  { "op": "remove", "path": "/profile/oldField" }
]
```


## Important caveats and mapping errors

- **Type and polymorphism:** the processor deserializes back to
  `object.getClass()`. If your model relies on polymorphic deserialization
  (`@JsonTypeInfo`) or uses abstract base types, test that subtype information
  survives the round-trip. If it doesn't, preserve type metadata during
  serialization or adjust the approach.

- **Shared `ObjectMapper`:** the example builds its own `ObjectMapper`. If your
  application configures a global mapper (date formats, modules, mixins),
  consider injecting that mapper to ensure consistent behavior across the app.

- **Validation model:** this approach validates the whole object after applying
  the patch. If you require partial/field-only validation, you'll need a
  different validation strategy that checks only the changed fields.

- **Performance:** each patch performs serialization, patching, and
  deserialization. For large objects or high throughput, consider applying
  patches to Jackson `JsonNode` trees and mapping to domain objects only when
  necessary.

Error mapping recommendation:

- Use a `@ControllerAdvice` to convert `ConstraintViolationException` to HTTP
  422 (unprocessable content) with a structured list of field errors.
- Convert `JsonPatchException` to HTTP 400 with a clear, non-sensitive message
  describing the JSON/patch problem.

## Tests and low-risk improvements

Suggested tests:

1. Happy path — a `JsonMergePatch` changes a field and the resulting object
   validates.
1. Validation failure — a patch produces an invalid object and
   `ConstraintViolationException` is thrown.
1. Malformed patch — malformed or incompatible operations produce
   `JsonPatchException`.
1. Polymorphism — verify subtype fields survive the round-trip when your app
   uses `@JsonTypeInfo` or other polymorphic settings.

Example JUnit snippet:

```java
@Test
void mergePatch_updatesField_andValidates() {
	final var user = new User(1L, "old@example.com", "Old Name");
	final var patch = Json.createMergePatch(
		Json.createObjectBuilder()
			.add("email", "new@example.com")
			.build());
	final var patched = jsonPatchProcessor.patch(user, patch);
	assertEquals("new@example.com", patched.getEmail());
}
```
## Full implementation

```java
import java.io.StringReader;
import java.util.Set;
import java.util.function.Function;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.json.Json;
import jakarta.json.JsonException;
import jakarta.json.JsonMergePatch;
import jakarta.json.JsonPatch;
import jakarta.json.JsonStructure;
import jakarta.json.JsonValue;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.ConstraintViolationException;
import jakarta.validation.Validator;

/**
 * A component that applies JSON Patch and JSON Merge Patch operations to Java objects.
 * This class ensures that the patch operations are applied to a copy of the original
 * object and that the resulting object is validated before being returned.
 *
 * This component uses Jackson for serialization/deserialization and Jakarta JSON for patch operations.
 *
 * @see <a href="https://tools.ietf.org/html/rfc6902">RFC 6902: JSON Patch</a>
 * @see <a href="https://tools.ietf.org/html/rfc7396">RFC 7396: JSON Merge Patch</a>
 */
@Component
public class JsonPatchProcessor {

	private static final Logger log = LoggerFactory.getLogger(JsonPatchProcessor.class);

	private final ObjectMapper objectMapper = new ObjectMapper()
		.findAndRegisterModules();

	private final Validator validator;

	public JsonPatchProcessor(Validator validator) {
		this.validator = validator;
	}

	/**
	 * Applies a JSON Merge Patch to the given object.
	 *
	 * @param <T> the type of the object to patch
	 * @param object the object to patch
	 * @param jsonMergePatch the JSON Merge Patch to apply
	 * @return the patched object
	 * @throws ConstraintViolationException if the patched object is not valid
	 */
	public <T> T patch(T object, JsonMergePatch jsonMergePatch) {
		return patch(object, target -> jsonMergePatch.apply(target));
	}

	/**
	 * Applies a JSON Patch to the given object.
	 *
	 * @param <T> the type of the object to patch
	 * @param object the object to patch
	 * @param jsonPatch the JSON Patch to apply
	 * @return the patched object
	 * @throws ConstraintViolationException if the patched object is not valid
	 */
	public <T> T patch(T object, JsonPatch jsonPatch) {
		return patch(object, target -> jsonPatch.apply(target));
	}

	/**
	 * Generic JSON patching method that delegates the actual patch application to a passed-in function.
	 * <p>
	 * This method first creates a deep copy of the input object. The patch function is then applied to this copy.
	 * Finally, the patched copy is validated. If validation is successful, the patched copy is returned.
	 *
	 * @param <T> the type of the object to patch
	 * @param object the object to patch
	 * @param patchFn a function that receives a {@link JsonStructure} representing the original object and returns the patched {@link JsonValue}
	 * @return the patched and validated object
	 * @throws ConstraintViolationException if the patched object does not pass validation
	 * @throws JsonPatchException if an error occurs during JSON processing
	 */
	@SuppressWarnings({ "unchecked" })
	protected <T> T patch(T object, Function<? super JsonStructure, ? extends JsonValue> patchFn) {
		Assert.notNull(object, "object is required; it must not be null");
		Assert.notNull(patchFn, "patchFn is required; it must not be null");

		try {
			log.debug("Patching object of type {}", object.getClass().getSimpleName());

			final var originalJsonString = objectMapper.writeValueAsString(object);

			try (final var jsonReader = Json.createReader(new StringReader(originalJsonString))) {
				final var originalJsonStructure = jsonReader.read();
				final var patchedJsonValue = patchFn.apply(originalJsonStructure);
				final var patchedJsonString = patchedJsonValue.toString();
				final var patchedObject = objectMapper.readValue(patchedJsonString, object.getClass());

				log.debug("Performing JSON patch validation");
				final Set<ConstraintViolation<Object>> violations = validator.validate(patchedObject);
				if (violations.isEmpty() == false) { throw new ConstraintViolationException(violations); }
				log.debug("No validation errors for {}", object.getClass().getSimpleName());

				return (T) patchedObject;
			}
		}
		// JsonException can be thrown by Johnzon
		// JsonProcessingException can be thrown by Jackson
		catch (final JsonException | JsonProcessingException exception) {
			throw new JsonPatchException("An error occurred while JSON-Patching", exception);
		}
	}

}
```

## Spring converters

Spring MVC needs converters to convert incoming requests to `JsonMergePatch` and
`JsonPatch` instances:

### `JsonMergePatchHttpMessageConverter`

```java
import org.springframework.http.HttpInputMessage;
import org.springframework.http.HttpOutputMessage;
import org.springframework.http.converter.AbstractHttpMessageConverter;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.http.converter.HttpMessageNotWritableException;
import org.springframework.stereotype.Component;

import jakarta.json.Json;
import jakarta.json.JsonMergePatch;

/**
 * An {@link AbstractHttpMessageConverter} that can read and write {@link JsonMergePatch} objects.
 *
 * @see <a href="https://tools.ietf.org/html/rfc7396">RFC 7396: JSON Merge Patch</a>
 */
@Component
public class JsonMergePatchHttpMessageConverter extends AbstractHttpMessageConverter<JsonMergePatch> {

	public JsonMergePatchHttpMessageConverter() {
		super(JsonPatchMediaTypes.JSON_MERGE_PATCH);
	}

	@Override
	protected boolean supports(Class<?> clazz) {
		return JsonMergePatch.class.isAssignableFrom(clazz);
	}

	@Override
	protected JsonMergePatch readInternal(Class<? extends JsonMergePatch> clazz, HttpInputMessage httpInputMessage) {
		try (final var jsonReader = Json.createReader(httpInputMessage.getBody())) {
			return Json.createMergePatch(jsonReader.readValue());
		}
		catch (final Exception exception) {
			throw new HttpMessageNotReadableException("Could not read JSON merge-patch: " + exception.getMessage(), exception, httpInputMessage);
		}
	}

	@Override
	protected void writeInternal(JsonMergePatch jsonMergePatch, HttpOutputMessage httpOutputMessage) {
		try (final var jsonWriter = Json.createWriter(httpOutputMessage.getBody())) {
			jsonWriter.write(jsonMergePatch.toJsonValue());
		}
		catch (final Exception exception) {
			throw new HttpMessageNotWritableException("Could not write JSON merge-patch: " + exception.getMessage(), exception);
		}
	}

}
```

### JsonPatchHttpMessageConverter

```java
package ca.gov.dtsstn.vacman.api.json;

import org.springframework.http.HttpInputMessage;
import org.springframework.http.HttpOutputMessage;
import org.springframework.http.converter.AbstractHttpMessageConverter;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.http.converter.HttpMessageNotWritableException;
import org.springframework.stereotype.Component;

import jakarta.json.Json;
import jakarta.json.JsonPatch;

/**
 * An {@link AbstractHttpMessageConverter} that can read and write {@link JsonPatch} objects.
 *
 * @see <a href="https://tools.ietf.org/html/rfc6902">RFC 6902: JavaScript Object Notation (JSON) Patch</a>
 */
@Component
public class JsonPatchHttpMessageConverter extends AbstractHttpMessageConverter<JsonPatch> {

	public JsonPatchHttpMessageConverter() {
		super(JsonPatchMediaTypes.JSON_PATCH);
	}

	@Override
	protected boolean supports(Class<?> clazz) {
		return JsonPatch.class.isAssignableFrom(clazz);
	}

	@Override
	protected JsonPatch readInternal(Class<? extends JsonPatch> clazz, HttpInputMessage httpInputMessage) {
		try (final var jsonReader = Json.createReader(httpInputMessage.getBody())) {
			return Json.createPatch(jsonReader.readArray());
		}
		catch (final Exception exception) {
			throw new HttpMessageNotReadableException("Could not read JSON patch: " + exception.getMessage(), exception, httpInputMessage);
		}
	}

	@Override
	protected void writeInternal(JsonPatch jsonPatch, HttpOutputMessage httpOutputMessage) {
		try (final var jsonWriter = Json.createWriter(httpOutputMessage.getBody())) {
			jsonWriter.write(jsonPatch.toJsonArray());
		}
		catch (final Exception exception) {
			throw new HttpMessageNotWritableException("Could not write JSON patch: " + exception.getMessage(), exception);
		}
	}

}
```
