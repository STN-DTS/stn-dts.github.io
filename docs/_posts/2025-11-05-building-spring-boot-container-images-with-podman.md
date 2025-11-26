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

### 1. Configure the Spring Boot Maven or Gradle plugin

You need to configure the Spring Boot plugin to bind the host to the builder.
This allows the build process (which runs inside a container) to access the
Podman socket on the host.

**Maven (`pom.xml`):**

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

**Gradle (`build.gradle`):**

```groovy
tasks.named("bootBuildImage") {
    docker {
        bindHostToBuilder = true
    }
}
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
The socket will be available at `/run/user/${UID}/podman/podman.sock` (where
`1000` is typically your user ID).

### 3. Set the `DOCKER_HOST` environment variable

Spring Boot's build-image goal expects to communicate with Docker, but you can
point it to Podman by setting the `DOCKER_HOST` environment variable.

**Maven:**

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock mvn spring-boot:build-image -Dmaven.test.skip=true
```

**Gradle:**

```bash
DOCKER_HOST=unix:///run/user/${UID}/podman/podman.sock ./gradlew bootBuildImage -x test
```

This tells the build process to use the Podman socket instead of the default
Docker socket. Skipping tests is optional but recommended for faster builds if
you've already verified your code.

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
image using the commands from Step 3.

The resulting image will be built using Podman and stored in your local Podman
registry. You can list it with:

```bash
podman images
```

And run it with:

```bash
podman run --interactive --rm --tty --network host your-app-name:latest
```

## Troubleshooting & Tips

### SELinux on Fedora/RHEL

If you are running on an SELinux-enabled system (like Fedora or RHEL), you might
encounter permission denied errors when the builder tries to access the socket.
You may need to ensure the socket is labeled correctly or temporarily set
SELinux to permissive mode to verify if it's the culprit.

### Storage Driver Performance

Podman works best with the `overlay` storage driver. If your builds are
exceptionally slow, check your storage driver:

```bash
podman info --format '{{.Store.GraphDriverName}}'
```

If it returns `vfs`, you should configure `fuse-overlayfs` for better
performance.

### Customizing the Image Name

By default, the image name is derived from your project's artifact ID and
version. You can customize this in your configuration:

**Maven:**

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

**Gradle:**

```groovy
bootBuildImage {
    docker {
        bindHostToBuilder = true
    }
    imageName = "my-registry.com/my-org/${project.name}:${project.version}"
}
```

### Common Issues

1. **Socket not found**: Verify the socket path exists.
2. **Permission denied**: Ensure your user has access to the socket.
3. **Builder failure**: Run with `-X` (Maven) or `--debug` (Gradle) to see
   detailed logs from the buildpack.

## Conclusion

Using Podman with Spring Boot provides an alternative to Docker for building
container images, especially in environments where running a Docker daemon isn't
desirable. The configuration is straightforward and allows you to leverage
Spring Boot's excellent container build support with Podman's daemonless
architecture.
