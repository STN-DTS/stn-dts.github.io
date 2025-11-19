---
layout: post
title: Building Spring Boot container images with Podman
author: Greg Baker
date: 2025-11-05
categories: spring-boot podman containers java
---

## Introduction

Spring Boot provides excellent support for building container images using the
`spring-boot:build-image` Maven goal. By default, this uses Docker, but you can
also use Podman as an alternative container runtime. This post explains how to
configure your Spring Boot project to build images with Podman instead of
Docker.

## Prerequisites

Before building images with Podman, ensure you have Podman installed and
configured on your system. Podman is a daemonless container engine that's
compatible with Docker's CLI and image formats.

## Configuration Steps

### 1. Configure the Spring Boot Maven plugin

In your `pom.xml`, you need to configure the Spring Boot Maven plugin to bind
the host to the builder. This allows the build process to access the Podman
socket.

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <image>
      <bindHostToBuilder>true</bindHostToBuilder>
    </image>
  </configuration>
</plugin>
```

Setting `bindHostToBuilder` to `true` enables the builder to access host
resources, which is necessary when using Podman.

### 2. Enable the Podman socket

Podman uses a socket for communication, similar to Docker. You need to enable
the user-level Podman socket service:

```bash
systemctl --user enable --now podman.socket
```

This command enables and starts the Podman socket service for your user session.
The socket will be available at `/run/user/${UID}/podman/podman.sock`
(where `1000` is typically your user ID).

### 3. Set the `DOCKER_HOST` environment variable

Spring Boot's build-image goal expects to communicate with Docker, but you can
point it to Podman by setting the `DOCKER_HOST` environment variable:

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock mvn spring-boot:build-image --define maven.test.skip=true
```

This tells the build process to use the Podman socket instead of the default
Docker socket. The `--define maven.test.skip=true` flag skips running tests
during the build, which can speed up the process.

## Why these steps are necessary

- **bindHostToBuilder**: This configuration allows the Paketo buildpack (used by
  Spring Boot) to access the host's container runtime socket during the build
  process.

- **Podman socket**: Unlike Docker, which runs as a system daemon, Podman can
  run rootless and uses user-specific sockets. Enabling the socket allows the
  build process to communicate with Podman.

- **DOCKER_HOST**: Spring Boot's build-image goal is hardcoded to look for
  Docker, but by setting this environment variable, we redirect it to use Podman
  instead.

## Building the image

Once configured, you can build your Spring Boot application into a container
image:

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock mvn spring-boot:build-image --define maven.test.skip=true
```

The resulting image will be built using Podman and stored in your local Podman
registry. You can list it with:

```bash
podman images
```

And run it with:

```bash
podman run --interactive --rm --tty --network host your-app-name:latest
```

## Troubleshooting

If you encounter issues:

1. Verify Podman is installed: `podman --version`
2. Check the socket is running: `systemctl --user status podman.socket`
3. Ensure the socket path is correct for your user ID: `echo $UID`
4. Test Podman connectivity: `podman info`

## Conclusion

Using Podman with Spring Boot provides an alternative to Docker for building
container images, especially in environments where running a Docker daemon isn't
desirable. The configuration is straightforward and allows you to leverage
Spring Boot's excellent container build support with Podman's daemonless
architecture.
