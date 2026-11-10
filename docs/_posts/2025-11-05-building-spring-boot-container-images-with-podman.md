---
layout: post
title: Building Spring Boot container images with Podman
author: Greg Baker
date: 2025-11-05
categories: spring-boot podman containers java
---

Spring Boot can turn your app into a container image for you with the `spring-boot:build-image` Maven goal (or
`bootBuildImage` in Gradle). Out of the box it expects Docker. If you'd rather use Podman, it works fine, but you need to
set up three things first. This post walks through them.

You'll need Podman installed and working. If you haven't used it before, Podman is a container engine that doesn't need
a background daemon. It understands the same commands and image formats as Docker, so most Docker tooling can talk to it.

## 1. Let the builder reach the host

Spring Boot builds the image with Paketo buildpacks, and the buildpack runs *inside* a container. That container needs to
reach the Podman socket on your machine. To allow it, set `bindHostToBuilder` to `true` in the Spring Boot plugin
config.

For Maven, in `pom.xml`:

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <docker>
      <bindHostToBuilder>true</bindHostToBuilder>
    </docker>
  </configuration>
</plugin>
```

For Gradle, in `build.gradle`:

```groovy
tasks.named("bootBuildImage") {
    docker {
        bindHostToBuilder = true
    }
}
```

## 2. Turn on the Podman socket

Docker runs as a system-wide daemon that tools talk to through a socket file. Podman can run rootless (as your normal
user, without root), so instead it gives each user their own socket. That socket is off by default. Turn it on with:

```bash
systemctl --user enable --now podman.socket
```

This starts the socket now and every time you log in. It lives at `/run/user/${UID}/podman/podman.sock`, where `${UID}`
is your user ID (usually `1000`).

## 3. Point the build at Podman

The build-image goal talks to Docker, but it decides *where* Docker is by reading the `DOCKER_HOST` environment
variable. Set that to the Podman socket and the build uses Podman instead.

With Maven:

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock mvn spring-boot:build-image -Dmaven.test.skip=true
```

With Gradle:

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock ./gradlew bootBuildImage -x test
```

Skipping the tests isn't required. It just makes the build faster if you've already run them.

## Running the image

When the build finishes, the image is stored in Podman's local image storage. You can see it with:

```bash
podman images
```

And run it with:

```bash
podman run --interactive --rm --tty --network host your-app-name:latest
```

## Troubleshooting and tips

### SELinux on Fedora or RHEL

On systems with SELinux turned on, such as Fedora and RHEL, you might get "permission denied" errors when the builder
tries to use the socket. You may need to make sure the socket has the right SELinux label. To check whether SELinux is
the problem at all, you can temporarily switch it to permissive mode and try again.

### Slow builds

Podman works best with the `overlay` storage driver. If your builds are very slow, check which driver you're using:

```bash
podman info --format '{% raw %}{{.Store.GraphDriverName}}{% endraw %}'
```

If it says `vfs`, set up `fuse-overlayfs` instead. It's much faster.

### Changing the image name

By default the image is named after your project's artifact ID and version. You can change that in the plugin config.

Maven:

```xml
<configuration>
  <docker>
    <bindHostToBuilder>true</bindHostToBuilder>
  </docker>
  <image>
    <name>my-registry.com/my-org/${project.artifactId}:${project.version}</name>
  </image>
</configuration>
```

Gradle:

```groovy
bootBuildImage {
    docker {
        bindHostToBuilder = true
    }
    imageName = "my-registry.com/my-org/${project.name}:${project.version}"
}
```

### Common errors

If the build says the socket isn't found, check that the socket file actually exists at the path you gave in
`DOCKER_HOST`. If you get "permission denied", make sure your user can access the socket. If the buildpack itself fails,
run the build again with `-X` (Maven) or `--debug` (Gradle) to get detailed logs.

## Wrapping up

That's all it takes. Once the socket is on and `DOCKER_HOST` points at it, Spring Boot's image building works the same
with Podman as it does with Docker. It's a good option anywhere you don't want to run a Docker daemon.
