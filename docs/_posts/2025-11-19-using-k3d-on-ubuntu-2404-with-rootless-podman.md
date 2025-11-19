---
layout: post
title: "Using k3d on Ubuntu 24.04 with rootless Podman"
date: 2025-11-19
author: Greg Baker
categories: kubernetes, k3d, podman
---

# Using k3d on Ubuntu 24.04 with rootless Podman

k3d creates Kubernetes clusters using k3s in Docker containers. To use k3d with
rootless Podman on Ubuntu 24.04, configure cgroup delegation and enable the
Podman socket for Docker API compatibility.

## Prerequisites

Ensure the following are installed:
- Podman configured for rootless operation
- k3d (install via `curl -s
  https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash`)

## Step 1: Enable cgroup `CPU`, `CPUSET`, and `I/O` delegation

Rootless Podman requires cgroup delegation to manage resources in user services.

Create `/etc/systemd/system/user@.service.d/delegate.conf` with:

```
[Service]
Delegate=cpu cpuset io memory pids
```

## Step 2: Enable Podman socket

Enable the Podman socket to provide a Docker-compatible API for k3d.

Run:

```bash
systemctl --user enable --now podman.socket
```

## Step 3: Export socket locations

Set environment variables to direct k3d to the Podman socket.

Export:

```bash
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
export DOCKER_SOCK=$XDG_RUNTIME_DIR/podman/podman.sock
```

To set these variables automatically at login, add the export commands to your
shell profile (e.g., `~/.bashrc` or `~/.zshrc`).

## Step 4: Create the k3d cluster

Create the cluster with user namespace support for rootless Podman.

Run:

```bash
k3d cluster create --k3s-arg '--kubelet-arg=feature-gates=KubeletInUserNamespace=true@server:*'
```

## Verification

Verify the cluster:

```bash
k3d cluster list
kubectl get nodes
```
