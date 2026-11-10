---
layout: post
title: "Using k3d on Ubuntu 24.04 with rootless Podman"
date: 2025-11-19
author: Greg Baker
categories:
- kubernetes
- k3d
- podman
- ubuntu
- linux
---

k3d runs a Kubernetes cluster on your machine by starting k3s (a small Kubernetes distribution) inside containers. It's
built for Docker, but it also works with rootless Podman, meaning Podman running as your normal user instead of root.
On Ubuntu 24.04 you need to do a bit of setup first: let your user manage more cgroup resources, raise the kernel's
file watcher limits, and turn on the Podman socket so k3d can talk to Podman as if it were Docker.

## What you need

- Podman, set up to run rootless
- k3d (you can install it with `curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash`)
- kubectl, to work with the cluster once it's running

## 1. Let your user control CPU, cpuset, and I/O

Linux uses cgroups (control groups) to limit how much CPU, memory, and so on a group of processes can use. By default,
systemd only hands a few of these controls to regular users. Kubernetes needs more of them, so we have to tell systemd
to delegate them to user sessions.

Create `/etc/systemd/system/user@.service.d/delegate.conf` (you'll need `sudo`) with this content:

```ini
[Service]
Delegate=cpu cpuset io memory pids
```

Then reload systemd:

```bash
sudo systemctl daemon-reload
```

This doesn't apply to your current session. Log out and back in (or reboot) before going further.

## 2. Turn on the Podman socket

k3d talks to its container engine through the Docker API. Podman can provide that same API through a socket, but it's
off by default. Turn it on with:

```bash
systemctl --user enable --now podman.socket
```

## 3. Tell k3d where the socket is

Next, set two environment variables. The k3d CLI reads `DOCKER_HOST` to find the API. `DOCKER_SOCK` is the plain file
path to the socket, which some scripts and tools expect instead.

```bash
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
export DOCKER_SOCK=$XDG_RUNTIME_DIR/podman/podman.sock
```

These only last for the current shell. To have them set every time you log in, add both lines to your shell profile,
such as `~/.bashrc` or `~/.zshrc`.

## 4. Raise the `inotify` limits

`inotify` is the Linux feature that lets programs watch files for changes. Each Kubernetes node uses a lot of these
watchers, and when you run several nodes (a server plus a few agents) as rootless containers on one machine, they all
come out of the same per-user limit.

With the default limits, the kubelet's `cAdvisor` (the part that collects container stats) quickly runs out and crashes
with `inotify_init: too many open files`. It does this quietly. The agents never finish starting, and `k3d` just hangs
forever waiting for the cluster to become "Ready". This one is easy to miss.

To fix it for good, create `/etc/sysctl.d/99-k3d.conf` (again with `sudo`):

```ini
fs.inotify.max_user_instances=8192
fs.inotify.max_user_watches=524288
```

Then apply the new limits right away, without rebooting:

```bash
sudo sysctl -p /etc/sysctl.d/99-k3d.conf
```

## 5. Create the cluster

Now create the cluster. Rootless Podman runs everything inside a user namespace, where the kubelet doesn't have the
host-level privileges it normally expects. The `KubeletInUserNamespace` feature gate tells the kubelet about this so it
doesn't crash. We pass it to both the server and the agents:

```bash
k3d cluster create --servers 1 --agents 3 --k3s-arg '--kubelet-arg=feature-gates=KubeletInUserNamespace=true@server:*' --k3s-arg '--kubelet-arg=feature-gates=KubeletInUserNamespace=true@agent:*'
```

To check that it worked:

```bash
k3d cluster list
kubectl get nodes
```

## Troubleshooting

### AppArmor and user namespaces

Ubuntu 24.04 restricts unprivileged user namespaces, and that can stop rootless Podman from creating containers. If you
see errors about user namespaces, AppArmor is the likely cause.

As a temporary workaround, you can turn the restriction off:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

For a permanent fix, use a version of Podman that ships the AppArmor profiles it needs, or write a profile that allows
`userns`.

### cgroup version

This setup needs cgroup v2. That's the default on Ubuntu 24.04, but you can check with:

```bash
podman info | grep "cgroup version"
```

You should see `cgroup version: v2`.
