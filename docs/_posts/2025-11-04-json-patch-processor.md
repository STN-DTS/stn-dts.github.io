---
layout: post
title: Safe, validated JSON Patch processing in Spring
author: Greg Baker
date: 2025-11-04
categories: api rest json-patch
---

An HTTP `PATCH` request asks the server to change part of an object instead of replacing the whole thing. If your API
accepts them, you need a predictable way to apply those partial updates without ending up with an object that breaks
your rules (for example, a user with an empty email address).

Here's the approach we use. We take the patch document, apply it to a *copy* of the object, validate the copy, and only
save it if it passes. The patch formats are the two standard ones: JSON Patch (RFC 6902), which is a list of operations
like "replace this field" or "remove that one", and JSON Merge Patch (RFC 7396), which is a partial JSON object that
gets merged into the original. Because we use existing implementations of both, we don't have to write our own patch
logic, and all the validation stays in one place.

The full code is at the end of the post. The sections before it explain how it works, what to watch out for, and how to
test it.

## What the processor does

`JsonPatchProcessor` takes a Java domain object and a patch document (either a `JsonPatch` or a `JsonMergePatch`). It
then:

1. Serializes the object to JSON with Jackson's `ObjectMapper`.
1. Applies the patch to that JSON using Jakarta JSON (`jakarta.json`).
1. Deserializes the patched JSON back into a new instance of the same class.
1. Validates the new instance with Jakarta Bean Validation (`Validator`).

If validation passes, you get the patched object back. If it fails, the processor throws a
`ConstraintViolationException`. If the JSON can't be parsed or the patch can't be applied, Jackson or Jakarta JSON
errors get wrapped in a `JsonPatchException`, so your controllers only have to deal with one exception type for those.

## Why we like this design

Turning the object into JSON and back gives us a deep copy for free. The original object is never touched, so a bad
patch can't leave it half-modified.

Validating the whole patched object, not just the fields that changed, means every rule on the class gets checked the
same way every time. Controllers don't need their own copies of the validation logic.

The cost is that every patch goes through a full serialize and deserialize. That's fine for typical payloads, but if
you expect very high throughput or very large objects, benchmark it first.

To sum up the error handling:

- `JsonPatchException` means the JSON couldn't be parsed or the patch couldn't be applied. Map it to HTTP 400.
- `ConstraintViolationException` means the patched object failed validation. Map it to HTTP 422 with field-level
  messages.

## Usage

In a Spring controller, inject the processor and pass it the existing object along with the parsed patch document. A
merge patch endpoint might look like this:

```java
@PatchMapping(path = "/users/{id}", consumes = "application/merge-patch+json")
public ResponseEntity<User> patchUser(@PathVariable Long id, @RequestBody JsonMergePatch mergePatch) {
	final var existing = userService.findById(id);
	final var patched = jsonPatchProcessor.patch(existing, mergePatch);
	final var saved = userService.save(patched);
	return ResponseEntity.ok(saved);
}
```

Here's what the two kinds of payload look like. A JSON Merge Patch (RFC 7396):

```json
{
  "email": "new.email@example.com",
  "profile": { "displayName": "New Name" }
}
```

And a JSON Patch (RFC 6902):

```json
[
  { "op": "replace", "path": "/email", "value": "new.email@example.com" },
  { "op": "remove", "path": "/profile/oldField" }
]
```


## Things to watch out for

The processor deserializes back into `object.getClass()`. If your model uses polymorphic types (for example
`@JsonTypeInfo`, which tells Jackson which subclass to create) or abstract base classes, test that the subtype
information survives the round trip. If it doesn't, you'll need to keep the type metadata during serialization or
change the approach.

The example creates its own `ObjectMapper`. If your app already configures a shared one with date formats, modules, or
mixins, inject that one instead so patching behaves the same as the rest of the app.

Validation always runs on the whole object after the patch is applied. If you need to validate only the fields that
changed, you'll need a different strategy.

Every patch does a serialize, a patch, and a deserialize. For large objects or high throughput, consider applying
patches to Jackson `JsonNode` trees and only mapping to domain objects when you need to.

For error responses, use a `@ControllerAdvice` to turn `ConstraintViolationException` into an HTTP 422 (unprocessable
content) with a structured list of field errors. Turn `JsonPatchException` into an HTTP 400 with a clear message about
the JSON or patch problem, without leaking sensitive details.

## Testing

These are the tests we'd write:

1. Happy path: a `JsonMergePatch` changes a field and the result passes validation.
1. Validation failure: a patch produces an invalid object and `ConstraintViolationException` is thrown.
1. Malformed patch: bad or incompatible operations produce a `JsonPatchException`.
1. Polymorphism: if your app uses `@JsonTypeInfo` or similar, subtype fields survive the round trip.

Here's a JUnit test for the happy path:

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

Spring MVC doesn't know how to turn a request body into a `JsonMergePatch` or `JsonPatch` on its own. These two message
converters handle that.

### JsonMergePatchHttpMessageConverter

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
