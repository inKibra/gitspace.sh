# Gitspace Infrastructure Architecture

> **⚠️ FUTURE VISION DOCUMENT**
>
> This document describes a **planned future architecture** that is **not yet implemented**.
> The current implementation uses a simpler model with direct PTY sessions and WebSocket relay.
> See [RELAY.md](./RELAY.md) and [GETTING-STARTED.md](./GETTING-STARTED.md) for the current implementation.

---

This document describes the infrastructure architecture for gitspace.sh - a platform for running development environments, CI/CD runners, and preview deployments using Firecracker microVMs.

## Table of Contents

1. [Vision](#vision)
2. [Architecture Overview](#architecture-overview)
3. [Orchestration Options](#orchestration-options)
4. [Flintlock: MicroVM Management](#flintlock-microvm-management)
5. [Nomad: Cluster Orchestration](#nomad-cluster-orchestration)
6. [Firecracker: The MicroVM Runtime](#firecracker-the-microvm-runtime)
7. [Image Build Pipeline](#image-build-pipeline)
8. [Storage Model](#storage-model)
9. [Networking Model](#networking-model)
10. [Cloudflare Tunnels: Public Ingress](#cloudflare-tunnels-public-ingress)
11. [GCP Integration](#gcp-integration)
12. [Local Development: Mac Parity](#local-development-mac-parity)
13. [Components to Build](#components-to-build)
14. [Decision Matrix](#decision-matrix)

---

## Vision

Gitspaces are lightweight, isolated environments that can be used for:

| Use Case | Description | Lifecycle |
|----------|-------------|-----------|
| **Dev Environment** | Interactive terminal access to a workspace | Long-running, persistent storage |
| **CI Runner** | Execute tests/builds on push/PR | Ephemeral, dies after job |
| **Preview Environment** | Run app for PR review | Medium-lived, public URL |

**Key Goals:**
- Scale to zero when idle ($0 cost)
- Use spot/preemptible instances for 60-90% cost savings
- Same environment from local dev → CI → preview
- E2E encrypted terminal access via gitspace.sh relay
- Simple: just write scripts, no GitHub Actions YAML ceremony

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER LAYER                                      │
│                                                                              │
│   gssh CLI ───────► Terminal access (E2E encrypted)                         │
│   Browser ─────────► Preview URLs (https://pr-123.preview.gitspace.sh)      │
│   GitHub ──────────► Webhooks (push, PR events)                             │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          CONTROL PLANE                                        │
│                                                                               │
│   gitspace.sh relay                                                          │
│   ├── User authentication (API keys)                                         │
│   ├── WebSocket relay (E2E encrypted terminal streams)                       │
│   ├── GitHub webhook handler                                                 │
│   ├── Job scheduler (submits to Nomad or custom)                            │
│   ├── Host provisioner (GCP API for scale up/down)                          │
│   └── State database (Postgres)                                              │
│                                                                               │
│   Nomad Server (optional, for multi-host)                                    │
│   ├── Job scheduling and bin packing                                         │
│   ├── Health monitoring                                                      │
│   └── Cluster state                                                          │
└──────────────────────────────────────────────┬───────────────────────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           DATA PLANE (Hosts)                                  │
│                                                                               │
│   Each host runs:                                                            │
│   ├── Nomad Client (receives jobs, reports capacity)                         │
│   ├── Flintlock (manages Firecracker VMs via gRPC)                          │
│   ├── containerd (pulls OCI images)                                          │
│   ├── cloudflared (tunnels for preview URLs)                                 │
│   └── Firecracker VMs (the actual gitspaces)                                │
│                                                                               │
│   Hosts can be:                                                              │
│   ├── GCP Spot VMs (cheap, can be preempted)                                │
│   ├── GCP On-Demand VMs (reliable, more expensive)                          │
│   ├── Latitude.sh Bare Metal (dedicated, hourly billing)                    │
│   ├── Your own computer (self-hosted)                                        │
│   └── Mac with Lima (local development)                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Orchestration Options

We have three main options for orchestrating gitspaces across hosts:

### Option A: Custom Orchestration (DIY)

Build our own scheduler in the relay.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          gitspace.sh relay                                   │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      Custom Scheduler                                   │ │
│  │                                                                         │ │
│  │  - Host registry (which hosts are available)                           │ │
│  │  - Capacity tracking (CPU/mem per host)                                │ │
│  │  - Simple scheduling (round-robin with capacity check)                 │ │
│  │  - Job queue (in-memory or Redis)                                      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Talks directly to gitspace-daemon on each host via WebSocket/gRPC          │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  gitspace-daemon (runs on each host)                                         │
│                                                                              │
│  - Manages Firecracker VMs directly (or via Flintlock)                      │
│  - Reports capacity to relay                                                │
│  - Handles volume management                                                │
│  - Manages Cloudflare tunnels                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Pros:**
- Full control
- No external dependencies
- Simpler for single-host
- Fun to build

**Cons:**
- Must build scheduling, health checks, failover
- More code to maintain
- Harder to get right at scale

**Best for:** Starting out, single host, learning

---

### Option B: Flintlock + Nomad

Use Flintlock for VM lifecycle, Nomad for scheduling.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          gitspace.sh relay                                   │
│                                                                              │
│  - Submits jobs to Nomad                                                    │
│  - Manages GCP hosts (scale up/down)                                        │
│  - WebSocket relay for terminal access                                      │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Nomad Cluster                                     │
│                                                                              │
│  Server: Scheduling, state, health monitoring                               │
│  Client: Runs on each host, executes jobs                                   │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Each Host                                                                   │
│                                                                              │
│  Nomad Client ──► Flintlock ──► Firecracker VMs                             │
│                       │                                                      │
│                       ▼                                                      │
│                  containerd (OCI images)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Pros:**
- Battle-tested scheduling (Nomad)
- Clean VM lifecycle management (Flintlock)
- OCI images for everything (containerd)
- Health checks, restarts, bin packing built-in

**Cons:**
- More moving parts
- Flintlock is community-maintained (was Weaveworks)
- Learning curve for Nomad

**Best for:** Multi-host production, scaling

---

### Option C: Nomad Only (with raw_exec or custom driver)

Use Nomad for scheduling, manage Firecracker directly.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Nomad Cluster                                     │
│                                                                              │
│  Jobs use raw_exec or firecracker-task-driver to run VMs                    │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Each Host                                                                   │
│                                                                              │
│  Nomad Client ──► raw_exec ──► firecracker binary                           │
│                                     │                                        │
│                                     ▼                                        │
│                              Firecracker VMs                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Pros:**
- Nomad handles scheduling
- Fewer components than Flintlock
- Community firecracker-task-driver available

**Cons:**
- Must manage images ourselves (no containerd integration)
- firecracker-task-driver is also community-maintained
- More manual VM configuration

**Best for:** Middle ground, if Flintlock feels too heavy

---

## Flintlock: MicroVM Management

[Flintlock](https://github.com/liquidmetal-dev/flintlock) is a gRPC service for managing Firecracker/Cloud Hypervisor VMs on a single host.

### What Flintlock Does

| Capability | Description |
|------------|-------------|
| **VM Lifecycle** | Create, start, stop, delete microVMs |
| **OCI Images** | Pull kernel and rootfs from container registries |
| **containerd Integration** | Uses containerd for image management and snapshots |
| **Networking** | Configures TAP devices, CNI plugins |
| **Metadata** | Injects cloud-init/ignition for VM configuration |
| **gRPC API** | Clean, well-defined API for all operations |

### What Flintlock Does NOT Do

| Capability | Needs |
|------------|-------|
| Multi-host scheduling | Nomad or custom |
| Scale up/down hosts | Custom + cloud API |
| Cross-host networking | CNI/Tailscale/Cloudflare |
| Persistent volumes across hosts | Custom |

### Flintlock Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HOST                                            │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         flintlockd                                       ││
│  │                                                                          ││
│  │  gRPC API (:9090)                                                        ││
│  │    ├── CreateMicroVM(spec)                                              ││
│  │    ├── DeleteMicroVM(id)                                                ││
│  │    ├── GetMicroVM(id)                                                   ││
│  │    └── ListMicroVMs()                                                   ││
│  │                                                                          ││
│  │  Uses containerd for:                                                    ││
│  │    ├── Pulling OCI images (kernel, rootfs)                              ││
│  │    └── Managing devicemapper snapshots                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                              │                                               │
│          ┌───────────────────┼───────────────────┐                          │
│          ▼                   ▼                   ▼                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│   │ Firecracker │     │ Firecracker │     │ Firecracker │                   │
│   │ MicroVM     │     │ MicroVM     │     │ MicroVM     │                   │
│   └─────────────┘     └─────────────┘     └─────────────┘                   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Flintlock MicroVM Spec

```json
{
  "id": "gitspace-abc123",
  "namespace": "gitspaces",
  "labels": {
    "user_id": "user-xyz",
    "workspace": "my-project"
  },
  "vcpu": 2,
  "memory_in_mb": 2048,
  "kernel": {
    "image": "ghcr.io/gitspace/kernel:5.10",
    "filename": "vmlinux"
  },
  "root_volume": {
    "id": "root",
    "is_read_only": false,
    "source": {
      "container_source": "ghcr.io/gitspace/ubuntu:22.04"
    }
  },
  "additional_volumes": [
    {
      "id": "workspace",
      "is_read_only": false,
      "mount_point": "/workspace",
      "source": {
        "host_path": "/var/lib/gitspace/volumes/user-xyz/my-project"
      }
    }
  ],
  "interfaces": [
    {
      "device_id": "eth0",
      "type": "TAP"
    }
  ],
  "metadata": {
    "user-data": "<base64-encoded-cloud-init>"
  }
}
```

### Flintlock Configuration

```yaml
# /etc/flintlock/config.yaml

containerd-socket: /run/containerd/containerd.sock
grpc-endpoint: 0.0.0.0:9090
state-dir: /var/lib/flintlock/vm
default-vmm: firecracker
firecracker-bin: /usr/local/bin/firecracker
bridge-name: flbr0
```

---

## Nomad: Cluster Orchestration

[Nomad](https://www.nomadproject.io/) is HashiCorp's workload orchestrator. Simpler than Kubernetes, supports VMs and other non-container workloads.

### Nomad Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Nomad Server Cluster                                 │
│                                                                              │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                    │
│  │ Nomad Server  │  │ Nomad Server  │  │ Nomad Server  │                    │
│  │ (Leader)      │◄─┤ (Follower)    │◄─┤ (Follower)    │                    │
│  └───────────────┘  └───────────────┘  └───────────────┘                    │
│                                                                              │
│  Responsibilities:                                                          │
│    ├── Leader election (Raft consensus)                                     │
│    ├── Job scheduling and placement                                         │
│    ├── Cluster state                                                        │
│    └── Health monitoring                                                    │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
              ┌────────────────────────────────┼────────────────────────────────┐
              │                                │                                │
              ▼                                ▼                                ▼
┌───────────────────────┐       ┌───────────────────────┐       ┌───────────────────────┐
│    Nomad Client       │       │    Nomad Client       │       │    Nomad Client       │
│    (Host 1)           │       │    (Host 2)           │       │    (Host 3)           │
│                       │       │                       │       │                       │
│  - Receives jobs      │       │  - Receives jobs      │       │  - Receives jobs      │
│  - Reports capacity   │       │  - Reports capacity   │       │  - Reports capacity   │
│  - Runs task drivers  │       │  - Runs task drivers  │       │  - Runs task drivers  │
└───────────────────────┘       └───────────────────────┘       └───────────────────────┘
```

### Nomad Server Configuration

```hcl
# /etc/nomad.d/server.hcl

datacenter = "gcp-us-central1"
data_dir   = "/opt/nomad/data"

server {
  enabled          = true
  bootstrap_expect = 3
  encrypt          = "GOSSIP_ENCRYPTION_KEY"
}

addresses {
  http = "0.0.0.0"
  rpc  = "0.0.0.0"
  serf = "0.0.0.0"
}

acl {
  enabled = true
}
```

### Nomad Client Configuration

```hcl
# /etc/nomad.d/client.hcl

datacenter = "gcp-us-central1"
data_dir   = "/opt/nomad/data"

client {
  enabled = true

  meta {
    "zone"          = "us-central1-a"
    "spot"          = "true"
    "has_flintlock" = "true"
  }

  host_volume "gitspace-volumes" {
    path      = "/var/lib/gitspace/volumes"
    read_only = false
  }
}

servers = ["nomad-server.internal:4647"]

plugin "raw_exec" {
  config {
    enabled = true
  }
}
```

### Nomad Job Types

**Service Jobs** (long-running):
```hcl
job "gitspace-dev" {
  type = "service"
  # ... runs until stopped
}
```

**Batch Jobs** (run to completion):
```hcl
job "gitspace-ci" {
  type = "batch"
  # ... runs until exit, with timeout
}
```

**Parameterized Jobs** (templates):
```hcl
job "gitspace" {
  type = "service"

  parameterized {
    meta_required = ["user_id", "workspace_id"]
  }

  # Each dispatch creates a child job
}
```

### Example: Gitspace Service Job

```hcl
job "gitspace" {
  type        = "service"
  datacenters = ["gcp-us-central1"]

  parameterized {
    meta_required = ["user_id", "workspace_id", "workspace_name"]
    meta_optional = ["cpu", "memory", "zone"]
  }

  group "microvm" {
    count = 1

    constraint {
      attribute = "${meta.has_flintlock}"
      value     = "true"
    }

    volume "workspace" {
      type   = "host"
      source = "gitspace-volumes"
    }

    task "vm" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/flintlock-ctl"
        args    = ["microvm", "create", "--json-spec", "${NOMAD_TASK_DIR}/spec.json"]
      }

      template {
        destination = "local/spec.json"
        data = <<EOF
{
  "id": "{{ env "NOMAD_META_workspace_id" }}",
  "namespace": "gitspaces",
  "vcpu": {{ env "NOMAD_META_cpu" | default "2" }},
  "memory_in_mb": {{ env "NOMAD_META_memory" | default "2048" }},
  "kernel": {
    "image": "ghcr.io/gitspace/kernel:5.10"
  },
  "root_volume": {
    "source": {
      "container_source": "ghcr.io/gitspace/ubuntu:22.04"
    }
  }
}
EOF
      }

      resources {
        cpu    = 2000
        memory = 2048
      }
    }
  }
}
```

### Example: CI Batch Job

```hcl
job "ci" {
  type        = "batch"
  datacenters = ["gcp-us-central1"]

  parameterized {
    meta_required = ["repo", "commit_sha", "job_id"]
  }

  group "runner" {
    task "run" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/gitspace-ci-runner"
        args = [
          "--job-id", "${NOMAD_META_job_id}",
          "--repo", "${NOMAD_META_repo}",
          "--commit", "${NOMAD_META_commit_sha}",
        ]
      }

      resources {
        cpu    = 4000
        memory = 8192
      }
    }
  }
}
```

---

## Firecracker: The MicroVM Runtime

[Firecracker](https://firecracker-microvm.github.io/) is a lightweight VMM (Virtual Machine Monitor) designed for serverless and container workloads.

### Key Characteristics

| Property | Value |
|----------|-------|
| **Boot time** | <125ms |
| **Memory overhead** | <5 MiB per VM |
| **Creation rate** | Up to 150 VMs/second/host |
| **Isolation** | Hardware virtualization (KVM) |
| **Supported arch** | x86_64, aarch64 |

### Firecracker Configuration

```json
{
  "boot-source": {
    "kernel_image_path": "/var/lib/firecracker/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "/var/lib/firecracker/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    },
    {
      "drive_id": "workspace",
      "path_on_host": "/var/lib/gitspace/volumes/user-xyz/workspace.ext4",
      "is_root_device": false,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": 2,
    "mem_size_mib": 2048
  },
  "network-interfaces": [
    {
      "iface_id": "eth0",
      "guest_mac": "AA:FC:00:00:00:01",
      "host_dev_name": "tap0"
    }
  ]
}
```

### Requirements

- Linux host with KVM enabled
- `/dev/kvm` accessible
- For nested virtualization (VMs inside VMs):
  - GCP: `--enable-nested-virtualization` on n2 instances
  - Mac: macOS 15+ with M2/M3 chip, Lima with `nestedVirtualization: true`

---

## Image Build Pipeline

We own the image pipeline to ensure parity across all environments.

### Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         IMAGE BUILD PIPELINE                                 │
│                                                                              │
│   Dockerfile                                                                 │
│       │                                                                      │
│       ▼                                                                      │
│   BuildKit (multi-arch: amd64, arm64)                                       │
│       │                                                                      │
│       ▼                                                                      │
│   OCI Image                                                                  │
│       │                                                                      │
│       ├──────────────────────────────────────┐                              │
│       ▼                                      ▼                              │
│   Push to Registry                     Convert to rootfs                    │
│   (ghcr.io/gitspace/...)              (for direct Firecracker use)         │
│       │                                      │                              │
│       ▼                                      ▼                              │
│   Flintlock pulls via containerd       Manual FC config                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Base Image Dockerfile

```dockerfile
# images/ubuntu-base/Dockerfile

FROM ubuntu:22.04

# System packages
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    sudo \
    openssh-server \
    && rm -rf /var/lib/apt/lists/*

# Create gitspace user
RUN useradd -m -s /bin/bash gitspace && \
    echo "gitspace ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install common dev tools
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -fsSL https://get.docker.com | bash

# tmux-lite-server for terminal access
COPY --from=gitspace/tmux-lite:latest /usr/local/bin/tmux-lite-server /usr/local/bin/

# Cloud-init for configuration
RUN apt-get update && apt-get install -y cloud-init

# Startup script
COPY startup.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/startup.sh

CMD ["/usr/local/bin/startup.sh"]
```

### Build Script

```bash
#!/bin/bash
# scripts/build-images.sh

set -e

REGISTRY="ghcr.io/gitspace"
VERSION="${1:-latest}"

# Build multi-arch
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --push \
  -t "${REGISTRY}/ubuntu:${VERSION}" \
  -f images/ubuntu-base/Dockerfile \
  images/ubuntu-base/

# Build kernel image
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --push \
  -t "${REGISTRY}/kernel:5.10" \
  -f images/kernel/Dockerfile \
  images/kernel/

echo "Images pushed to ${REGISTRY}"
```

### Converting OCI to rootfs (for direct Firecracker use)

```bash
#!/bin/bash
# scripts/oci-to-rootfs.sh

IMAGE="ghcr.io/gitspace/ubuntu:latest"
OUTPUT="rootfs.ext4"
SIZE_MB=4096

# Pull and extract
skopeo copy "docker://${IMAGE}" "oci:image:latest"
umoci unpack --image image:latest bundle

# Create ext4 filesystem
dd if=/dev/zero of="${OUTPUT}" bs=1M count="${SIZE_MB}"
mkfs.ext4 "${OUTPUT}"

# Mount and copy
mkdir -p /tmp/rootfs
mount -o loop "${OUTPUT}" /tmp/rootfs
cp -a bundle/rootfs/* /tmp/rootfs/
umount /tmp/rootfs

echo "Created ${OUTPUT}"
```

---

## Storage Model

### Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STORAGE MODEL                                      │
│                                                                              │
│   Root Volume (ephemeral)                                                    │
│   ├── OCI image pulled by containerd                                        │
│   ├── Read-write, but reset on VM restart                                   │
│   └── Contains OS, tools, runtime                                           │
│                                                                              │
│   Workspace Volume (persistent)                                              │
│   ├── Sparse ext4 file on host                                              │
│   ├── Attached as /dev/vdb, mounted at /workspace                           │
│   ├── Survives VM restarts                                                  │
│   └── User's code, data, config                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Host Storage Layout

```
/var/lib/gitspace/
├── images/                          # Cached rootfs images
│   ├── ubuntu-22.04.ext4
│   └── node-20.ext4
│
├── kernel/                          # Kernel images
│   └── vmlinux-5.10
│
└── volumes/                         # Persistent workspace volumes (btrfs)
    ├── user-abc/
    │   ├── workspace-1.ext4        # Sparse file, grows on demand
    │   └── workspace-2.ext4
    └── user-def/
        └── workspace-1.ext4
```

### Btrfs for Volume Management

```bash
# Initial setup
mkfs.btrfs /dev/sdb
mount /dev/sdb /var/lib/gitspace/volumes

# Create workspace with quota
btrfs subvolume create /var/lib/gitspace/volumes/@user-abc-ws-1
btrfs qgroup limit 20G /var/lib/gitspace/volumes/@user-abc-ws-1

# Create sparse ext4 file (100GB logical, ~30MB actual)
truncate -s 100G /var/lib/gitspace/volumes/@user-abc-ws-1/workspace.ext4
mkfs.ext4 -F workspace.ext4

# Snapshot for backup
btrfs subvolume snapshot \
  /var/lib/gitspace/volumes/@user-abc-ws-1 \
  /var/lib/gitspace/snapshots/@user-abc-ws-1-$(date +%Y%m%d)
```

### Storage Tiers

| Tier | Quota per Workspace | Max Workspaces |
|------|---------------------|----------------|
| Free | 5 GB | 2 |
| Pro | 20 GB | 10 |
| Team | 50 GB | 50 |

### GCP Persistent Disk Setup

```bash
# Create persistent disk
gcloud compute disks create gitspace-volumes \
  --size=1TB \
  --type=pd-ssd \
  --zone=us-central1-a

# Attach to VM
gcloud compute instances attach-disk gitspace-host \
  --disk=gitspace-volumes \
  --zone=us-central1-a

# Inside VM: format as btrfs
mkfs.btrfs /dev/sdb
mount /dev/sdb /var/lib/gitspace/volumes
```

---

## Networking Model

### Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          NETWORKING MODEL                                    │
│                                                                              │
│   Terminal Access:                                                          │
│   └── gitspace.sh relay (WebSocket, E2E encrypted)                          │
│       └── User ◄──wss──► Relay ◄──wss──► tmux-lite-server in VM            │
│                                                                              │
│   Preview URLs (Public HTTP):                                               │
│   └── Cloudflare Tunnel (outbound only)                                     │
│       └── User ◄──https──► Cloudflare ◄──tunnel──► App in VM               │
│                                                                              │
│   VM Internet Access (Outbound):                                            │
│   └── NAT via host (iptables masquerade)                                    │
│       └── VM ──► TAP ──► Bridge ──► Host ──► Internet                       │
│                                                                              │
│   VM-to-VM (Same Host):                                                     │
│   └── Bridge network                                                        │
│       └── VM1 ◄──► Bridge ◄──► VM2                                          │
│                                                                              │
│   VM-to-VM (Cross Host):                                                    │
│   └── Not needed! Use public preview URLs                                   │
│       └── Frontend calls https://api-pr-123.preview.gitspace.sh             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### TAP/Bridge Setup (per host)

```bash
# Create bridge
ip link add name flbr0 type bridge
ip addr add 10.100.0.1/24 dev flbr0
ip link set flbr0 up

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# NAT for outbound traffic
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i flbr0 -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o flbr0 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

### Per-VM TAP Device

```bash
# Created by Flintlock automatically
ip tuntap add dev tap0 mode tap
ip link set tap0 master flbr0
ip link set tap0 up

# VM gets IP via DHCP or static config
# Inside VM: eth0 = 10.100.0.2/24, gateway = 10.100.0.1
```

---

## Cloudflare Tunnels: Public Ingress

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE TUNNEL                                     │
│                                                                              │
│   User Browser                                                              │
│       │                                                                      │
│       │ https://pr-123.preview.gitspace.sh                                  │
│       ▼                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Cloudflare Edge                                   │   │
│   │  - SSL termination                                                   │   │
│   │  - DDoS protection                                                   │   │
│   │  - WAF                                                               │   │
│   │  - Routes by hostname                                                │   │
│   └──────────────────────────────┬──────────────────────────────────────┘   │
│                                  │                                           │
│                                  │ Tunnel (outbound from origin)            │
│                                  ▼                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Host (gitspace-host-xyz)                          │   │
│   │                                                                      │   │
│   │   cloudflared ◄─────────────────────────────────────────────────────┤   │
│   │       │                                                              │   │
│   │       │ localhost:8080                                               │   │
│   │       ▼                                                              │   │
│   │   Firecracker VM (app running on :3000, mapped to host :8080)       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tunnel Configuration

```yaml
# /etc/cloudflared/config.yml

tunnel: gitspace-previews
credentials-file: /etc/cloudflared/creds.json

ingress:
  # Wildcard for preview URLs
  - hostname: "*.preview.gitspace.sh"
    service: http://localhost:8080

  # Catch-all
  - service: http_status:404
```

### Per-Gitspace Tunnel Management

```typescript
// In gitspace-daemon or relay

async function createPreviewTunnel(gitspaceId: string, port: number) {
  const hostname = `${gitspaceId}.preview.gitspace.sh`;

  // Create DNS record pointing to tunnel
  await cloudflare.dns.create({
    zone: 'gitspace.sh',
    type: 'CNAME',
    name: hostname,
    content: 'tunnel-id.cfargotunnel.com',
    proxied: true,
  });

  // Update tunnel ingress
  await updateTunnelConfig(hostname, `http://localhost:${port}`);

  return `https://${hostname}`;
}
```

### Pricing

| Tier | Tunnels | Cost |
|------|---------|------|
| Free | 50 | $0 |
| Pro | Unlimited | $20/mo |

---

## GCP Integration

### Spot VMs for Cost Savings

| VM Type | On-Demand | Spot | Savings |
|---------|-----------|------|---------|
| n2-standard-2 | ~$50/mo | ~$15/mo | 70% |
| n2-standard-4 | ~$100/mo | ~$30/mo | 70% |
| n2-standard-8 | ~$200/mo | ~$60/mo | 70% |

### Provisioning a Host

```typescript
async function provisionHost(zone: string, spot: boolean) {
  const hostId = crypto.randomUUID();

  await gcp.instances.insert({
    project: PROJECT_ID,
    zone,
    requestBody: {
      name: `gitspace-host-${hostId}`,
      machineType: `zones/${zone}/machineTypes/n2-standard-8`,

      scheduling: {
        provisioningModel: spot ? 'SPOT' : 'STANDARD',
        instanceTerminationAction: 'DELETE',
        onHostMaintenance: 'TERMINATE',
      },

      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: `projects/${PROJECT_ID}/global/images/family/gitspace-host`,
            diskSizeGb: 100,
          },
        },
        {
          // Attached SSD for volumes
          autoDelete: false,
          initializeParams: {
            diskType: `zones/${zone}/diskTypes/pd-ssd`,
            diskSizeGb: 500,
          },
        },
      ],

      networkInterfaces: [{
        network: 'global/networks/gitspace-vpc',
        accessConfigs: [{ type: 'ONE_TO_ONE_NAT' }],
      }],

      metadata: {
        items: [
          { key: 'host-id', value: hostId },
          { key: 'startup-script-url', value: 'gs://gitspace-scripts/startup.sh' },
        ],
      },

      tags: { items: ['gitspace-host', 'nomad-client'] },

      serviceAccounts: [{
        email: `gitspace-host@${PROJECT_ID}.iam.gserviceaccount.com`,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }],
    },
  });

  return hostId;
}
```

### Auto-Scaling Logic

```typescript
async function checkAndScale() {
  const capacity = await getClusterCapacity();
  const pending = await getPendingAllocations();

  const utilization = capacity.cpu.used / capacity.cpu.total;

  // Scale up: pending jobs or high utilization
  if (pending.length > 0 || utilization > 0.8) {
    if (capacity.nodes < MAX_HOSTS) {
      await provisionHost(pickZone(), /* spot */ true);
    }
  }

  // Scale down: low utilization
  if (utilization < 0.2 && capacity.nodes > MIN_HOSTS) {
    const idleHost = await findIdleHost();
    if (idleHost && await hasBeenIdleFor(idleHost, 10 * 60 * 1000)) {
      await terminateHost(idleHost);
    }
  }
}
```

### Handling Spot Preemption

```bash
#!/bin/bash
# /usr/local/bin/preemption-handler.sh (runs on each host)

while true; do
  PREEMPTED=$(curl -s -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/instance/preempted)

  if [ "$PREEMPTED" = "TRUE" ]; then
    echo "Preemption notice, draining..."

    # Drain Nomad node
    nomad node drain -self -enable -deadline 25s -force

    # Stop Flintlock VMs gracefully
    flintlock-ctl microvm list | xargs -I {} flintlock-ctl microvm delete {}

    exit 0
  fi

  sleep 5
done
```

---

## Local Development: Mac Parity

### Requirements

- macOS 15 (Sequoia) or later
- Apple Silicon M2 or M3 (with hardware nested virtualization)
- Lima v1.0+

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              macOS Host                                      │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Lima VM (ARM64 Linux)                             │   │
│   │                    nestedVirtualization: true                        │   │
│   │                                                                      │   │
│   │   ┌─────────────────────────────────────────────────────────────┐   │   │
│   │   │                      KVM                                     │   │   │
│   │   └──────────────────────────┬──────────────────────────────────┘   │   │
│   │                              │                                       │   │
│   │   ┌──────────────────────────▼──────────────────────────────────┐   │   │
│   │   │                  Firecracker (aarch64)                       │   │   │
│   │   │                                                              │   │   │
│   │   │   ┌─────────┐  ┌─────────┐  ┌─────────┐                     │   │   │
│   │   │   │ MicroVM │  │ MicroVM │  │ MicroVM │                     │   │   │
│   │   │   └─────────┘  └─────────┘  └─────────┘                     │   │   │
│   │   └──────────────────────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Lima Setup

```bash
# Create Lima instance with nested virtualization
limactl create \
  --name=gitspace \
  --vm-type=vz \
  --mount-type=virtiofs \
  --set '.nestedVirtualization = true' \
  template://ubuntu

# Start it
limactl start gitspace

# Shell in
limactl shell gitspace

# Inside Lima: Install Firecracker (aarch64)
curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-aarch64.tgz | tar -xz
sudo mv release-*/firecracker /usr/local/bin/

# Verify KVM works
ls -la /dev/kvm
```

### Lima Configuration File

```yaml
# ~/.lima/gitspace/lima.yaml

vmType: vz
arch: aarch64
cpus: 4
memory: 8GiB
disk: 100GiB

nestedVirtualization: true

mounts:
  - location: "~"
    writable: true
  - location: "/tmp/lima"
    writable: true

provision:
  - mode: system
    script: |
      #!/bin/bash
      apt-get update
      apt-get install -y containerd

      # Install Firecracker
      curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-aarch64.tgz | tar -xz -C /usr/local/bin

      # Install Flintlock
      curl -L https://github.com/liquidmetal-dev/flintlock/releases/download/v0.9.0/flintlock_0.9.0_linux_arm64.tar.gz | tar -xz -C /usr/local/bin
```

### Parity Matrix

| Component | Mac (Lima) | GCP (Spot VM) |
|-----------|------------|---------------|
| Outer VM | Lima (Virtualization.framework) | GCE (KVM) |
| Inner VM | Firecracker (aarch64) | Firecracker (x86_64) |
| Image format | Same OCI image | Same OCI image |
| Storage | Local SSD | PD-SSD + btrfs |
| Networking | Lima bridge | GCP VPC + NAT |

**Key insight:** Same OCI images, same Firecracker, same gitspace experience. Only the architecture (arm64 vs x86_64) and outer layer differ.

---

## Components to Build

### Option A: DIY Orchestration

| Component | Description | Effort |
|-----------|-------------|--------|
| **gitspace-relay** | WebSocket relay, auth, GitHub hooks | High |
| **gitspace-daemon** | Runs on each host, manages VMs | High |
| **Custom scheduler** | Track hosts, schedule gitspaces | Medium |
| **Volume manager** | btrfs subvolumes, quotas | Medium |
| **Tunnel manager** | Cloudflare tunnel per gitspace | Low |
| **Image builder** | BuildKit pipeline | Medium |
| **CLI** | User-facing commands | Medium |
| **Web UI** | Dashboard (optional) | High |

**Total: 6-8 significant components**

### Option B: Flintlock + Nomad

| Component | Description | Effort |
|-----------|-------------|--------|
| **gitspace-relay** | WebSocket relay, auth, GitHub hooks, Nomad job submission | High |
| **Nomad job templates** | HCL templates for gitspaces | Low |
| **Volume manager** | btrfs subvolumes, quotas | Medium |
| **Tunnel manager** | Cloudflare tunnel per gitspace | Low |
| **Image builder** | BuildKit pipeline (OCI for Flintlock) | Medium |
| **Host provisioner** | GCP API for scale up/down | Medium |
| **CLI** | User-facing commands | Medium |

**Uses:** Nomad (scheduling), Flintlock (VM lifecycle), containerd (images)

**Total: 5-6 components, leveraging battle-tested tools**

### Option C: Nomad Only

| Component | Description | Effort |
|-----------|-------------|--------|
| **gitspace-relay** | WebSocket relay, auth, Nomad job submission | High |
| **gitspace-daemon** | Lighter version, manages FC directly | Medium |
| **Nomad job templates** | HCL with raw_exec for Firecracker | Medium |
| **Volume manager** | btrfs subvolumes, quotas | Medium |
| **Tunnel manager** | Cloudflare tunnel per gitspace | Low |
| **Image builder** | BuildKit + manual rootfs conversion | Medium |
| **Host provisioner** | GCP API for scale up/down | Medium |
| **CLI** | User-facing commands | Medium |

**Total: 6-7 components**

---

## Decision Matrix

| Factor | DIY | Flintlock + Nomad | Nomad Only |
|--------|-----|-------------------|------------|
| **Complexity** | High | Medium | Medium |
| **Dependencies** | Few | Nomad, Flintlock, containerd | Nomad |
| **Scheduling** | Build it | Nomad (proven) | Nomad (proven) |
| **VM lifecycle** | Build it | Flintlock (clean API) | Build it |
| **Image management** | Manual | containerd (OCI native) | Manual |
| **Scale to zero** | Build it | Build it | Build it |
| **Spot handling** | Build it | Nomad drain + build | Nomad drain + build |
| **Learning curve** | Low | Medium | Low-Medium |
| **Control** | Full | High | High |
| **Fun** | Most | Some | Some |

### Recommendation

**Start with:** Flintlock + Nomad

**Why:**
1. Nomad's scheduling is non-trivial to build correctly
2. Flintlock's OCI integration saves significant work
3. Both are well-documented with active communities
4. Can always replace components later
5. Focus engineering effort on the unique parts (relay, CLI, user experience)

**Progression:**
1. Single host + Flintlock (no Nomad) for initial development
2. Add Nomad when multi-host is needed
3. GCP Spot integration for cost optimization
4. Scale based on demand

---

## Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        GITSPACE INFRASTRUCTURE                               │
│                                                                              │
│   Control Plane                                                             │
│   ├── gitspace.sh relay (auth, WebSocket, GitHub, scheduling)               │
│   └── Nomad Server (job scheduling, cluster state)                          │
│                                                                              │
│   Data Plane (per host)                                                     │
│   ├── Nomad Client (receives jobs)                                          │
│   ├── Flintlock (manages Firecracker VMs)                                   │
│   ├── containerd (OCI images)                                               │
│   ├── cloudflared (preview tunnels)                                         │
│   └── Firecracker (microVMs)                                                │
│                                                                              │
│   Storage                                                                   │
│   ├── OCI images from registry (kernel, rootfs)                             │
│   └── btrfs volumes (persistent workspaces)                                 │
│                                                                              │
│   Networking                                                                │
│   ├── Terminal: WebSocket via relay (E2E encrypted)                         │
│   ├── Preview: Cloudflare Tunnel (HTTPS)                                    │
│   └── Outbound: NAT via host                                                │
│                                                                              │
│   Hosts                                                                     │
│   ├── GCP Spot VMs (scale 0 to N, 70% cheaper)                             │
│   ├── GCP On-Demand (reliable fallback)                                     │
│   ├── Latitude.sh Bare Metal (dedicated, hourly)                            │
│   ├── Self-hosted (your computer)                                           │
│   └── Mac + Lima (local development)                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

*Last updated: 2024-12*
