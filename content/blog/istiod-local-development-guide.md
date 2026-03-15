---
title: "Hacking on Istiod: A Step-by-Step Guide to Local Development and Testing"
date: 2026-03-15
draft: false
tags: ["istio", "istiod", "development", "kubernetes", "envoy", "xds"]
categories: ["operations"]
author: "Service Mesh Blog"
description: "A complete walkthrough for building, running, and debugging a modified Istiod locally — and watching your changes take effect on connected Envoy sidecar proxies in real time."
ShowToc: true
TocOpen: false
---

## Why Develop Istiod Locally?

Whether you're contributing upstream, building a custom control plane feature, or just trying to understand how Istio works under the hood, the ability to make a change to Istiod, rebuild it, deploy it to a local cluster, and see the effect on sidecar proxies is invaluable.

This guide walks you through the entire loop: **clone, change, build, deploy, observe**.

## Prerequisites

Install these before starting:

```bash
# Go (Istio requires Go 1.22+)
go version
# go version go1.22.x or higher

# Docker
docker version

# kind (Kubernetes in Docker)
kind version
# If not installed:
# brew install kind    (macOS)
# go install sigs.k8s.io/kind@latest

# kubectl
kubectl version --client

# istioctl (match the version you're building against)
# We'll build this from source too, but having a release version helps
curl -L https://istio.io/downloadIstio | sh -
```

## Step 1: Clone the Istio Repository

```bash
# Clone the main Istio repo
git clone https://github.com/istio/istio.git
cd istio

# Check out the branch you want to base your changes on
# For latest stable:
git checkout release-1.24
# Or stay on master for bleeding edge:
# git checkout master
```

## Step 2: Understand the Istiod Source Layout

Before making changes, orient yourself in the codebase:

```
istio/
├── pilot/
│   ├── cmd/
│   │   └── pilot-discovery/    # ← Istiod entrypoint (main.go)
│   └── pkg/
│       ├── bootstrap/          # ← Server startup, gRPC/HTTP listeners
│       ├── config/             # ← Config processing (VirtualService, etc.)
│       ├── features/           # ← Feature flags
│       ├── model/              # ← Internal data model (ServiceInstance, etc.)
│       ├── networking/
│       │   └── core/           # ← xDS generation (CDS, LDS, RDS, EDS)
│       ├── serviceregistry/    # ← K8s, MCP service discovery
│       ├── xds/                # ← xDS server implementation
│       │   ├── ads.go          # ← Aggregated Discovery Service
│       │   └── delta.go        # ← Delta xDS (incremental push)
│       └── security/           # ← CA, cert signing
├── pkg/
│   ├── config/                 # ← Config API types
│   ├── envoy/                  # ← Envoy API Go bindings
│   └── kube/                   # ← Kubernetes client helpers
├── manifests/                  # ← Helm charts & install templates
├── tools/                      # ← Build scripts
└── Makefile                    # ← Build targets
```

The key directories:
- **`pilot/pkg/xds/`** — where xDS responses are built and pushed to Envoy
- **`pilot/pkg/networking/core/`** — where Envoy listeners, routes, and clusters are generated
- **`pilot/pkg/model/`** — the internal model that bridges K8s resources to Envoy config

## Step 3: Create a Local Kubernetes Cluster

Use `kind` to create a cluster. We'll use a config that exposes ports needed for debugging:

```bash
cat <<'EOF' > kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  extraPortMappings:
  - containerPort: 30000
    hostPort: 15014
    protocol: TCP
  - containerPort: 30001
    hostPort: 15010
    protocol: TCP
EOF

kind create cluster --name istio-dev --config kind-config.yaml

# Verify
kubectl cluster-info --context kind-istio-dev
```

## Step 4: Make Your Change

Here's a concrete example — we'll add a custom response header to every Envoy sidecar via the xDS config that Istiod pushes. This proves the full loop: you change Istiod, and every connected proxy picks it up.

Edit `pilot/pkg/networking/core/listener_builder.go`:

```bash
# Open the listener builder
# Find the function that builds HTTP connection manager filters
```

For a simpler, more visible change, let's add a custom header to all outbound HTTP routes. Edit `pilot/pkg/networking/core/route/route.go`:

```go
// Find the function BuildHTTPRouteMatch or similar route-building function
// and add a response header to every generated route.

// Example: In the function that creates route.Route objects,
// add a response header manipulation:

// Before returning the route, add:
if route.ResponseHeadersToAdd == nil {
    route.ResponseHeadersToAdd = make([]*core.HeaderValueOption, 0)
}
route.ResponseHeadersToAdd = append(route.ResponseHeadersToAdd, &core.HeaderValueOption{
    Header: &core.HeaderValue{
        Key:   "x-istiod-dev",
        Value: "locally-modified",
    },
    AppendAction: core.HeaderValueOption_OVERWRITE_IF_EXISTS_OR_ADD,
})
```

> **Tip**: For your first time, start with something easily observable — like adding a header, modifying a log line, or changing a default timeout. You can verify it worked by inspecting Envoy's config dump.

## Step 5: Build Istiod

Istio uses `make` for builds. Build the `pilot-discovery` binary (which *is* Istiod):

```bash
# Build just the pilot-discovery binary for your platform
make build

# Or build only the pilot-discovery binary specifically:
go build -o out/pilot-discovery ./pilot/cmd/pilot-discovery

# Verify the binary
./out/pilot-discovery version
```

### Build the Docker Image

To deploy into kind, you need a container image:

```bash
# Build the Istiod Docker image
# This uses the Makefile target that builds all images
make docker.pilot

# Or build just the pilot image with a custom tag:
export HUB=localhost
export TAG=dev-$(date +%s)

make docker.pilot \
  HUB=${HUB} \
  TAG=${TAG}

# Verify the image was built
docker images | grep pilot
```

## Step 6: Load the Image into kind

kind uses its own container runtime, so you need to load images into it:

```bash
# Load your custom Istiod image into the kind cluster
kind load docker-image ${HUB}/pilot:${TAG} --name istio-dev

# Verify it's available inside the cluster
docker exec istio-dev-control-plane crictl images | grep pilot
```

## Step 7: Install Istio with Your Custom Istiod

Use `istioctl` to install Istio, overriding the Istiod image with your local build:

```bash
# Generate the install manifest with your custom image
istioctl install \
  --set profile=default \
  --set hub=${HUB} \
  --set tag=${TAG} \
  --set values.pilot.image=pilot \
  -y

# Verify Istiod is running with your image
kubectl get pods -n istio-system -o wide
kubectl describe pod -n istio-system -l app=istiod | grep Image:
# Should show: localhost/pilot:dev-xxxxx
```

If you already have Istio installed and want to swap just the Istiod image:

```bash
# Patch the existing deployment
kubectl set image deployment/istiod \
  -n istio-system \
  discovery=${HUB}/pilot:${TAG}

# Watch the rollout
kubectl rollout status deployment/istiod -n istio-system
```

## Step 8: Deploy a Test Application

Deploy a simple workload with sidecar injection to verify your changes:

```bash
# Enable sidecar injection on the default namespace
kubectl label namespace default istio-injection=enabled --overwrite

# Deploy httpbin (a useful test workload)
kubectl apply -f samples/httpbin/httpbin.yaml

# Deploy sleep (a client pod for testing)
kubectl apply -f samples/sleep/sleep.yaml

# Wait for pods with sidecars
kubectl wait --for=condition=Ready pod -l app=httpbin --timeout=120s
kubectl wait --for=condition=Ready pod -l app=sleep --timeout=120s

# Verify sidecar injection
kubectl get pods -l app=httpbin -o jsonpath='{.items[0].spec.containers[*].name}'
# Should output: httpbin istio-proxy
```

## Step 9: Verify Your Changes

### Check the Envoy Config Dump

The most direct way to see if your Istiod changes took effect is to inspect the Envoy sidecar's configuration:

```bash
# Dump the full Envoy config from the httpbin sidecar
istioctl proxy-config all deploy/httpbin -o json > /tmp/envoy-config.json

# If you added a response header, search for it:
grep -r "x-istiod-dev" /tmp/envoy-config.json
# Should find your header in the route configs

# Or check specific config types:
# Routes:
istioctl proxy-config routes deploy/httpbin -o json | grep "x-istiod-dev"

# Listeners:
istioctl proxy-config listeners deploy/httpbin

# Clusters:
istioctl proxy-config clusters deploy/httpbin
```

### Test End-to-End

```bash
# Send a request from sleep to httpbin and check response headers
kubectl exec deploy/sleep -c sleep -- \
  curl -s -D - http://httpbin.default:8000/get | head -20

# If you added the x-istiod-dev header, you should see:
# HTTP/1.1 200 OK
# x-istiod-dev: locally-modified
# ...
```

### Check Istiod Logs

```bash
# Stream Istiod logs to see xDS pushes
kubectl logs -n istio-system deploy/istiod -f | grep -E "(Push|push|xds|XDS)"

# You should see push events when config changes:
# "Full push triggered" or "Incremental push"
```

## Step 10: The Fast Iteration Loop

Once the initial setup is done, the iteration loop is:

```bash
# 1. Make your code change
vim pilot/pkg/networking/core/route/route.go

# 2. Rebuild the binary and image
make docker.pilot HUB=${HUB} TAG=${TAG}

# 3. Load into kind
kind load docker-image ${HUB}/pilot:${TAG} --name istio-dev

# 4. Restart Istiod to pick up the new image
kubectl rollout restart deployment/istiod -n istio-system

# 5. Wait for rollout
kubectl rollout status deployment/istiod -n istio-system

# 6. Verify
istioctl proxy-config routes deploy/httpbin -o json | grep "x-istiod-dev"
```

You can wrap this in a script:

```bash
#!/bin/bash
# dev-loop.sh — rebuild and redeploy Istiod
set -euo pipefail

export HUB=localhost
export TAG=dev-$(date +%s)

echo "==> Building pilot image (${HUB}/pilot:${TAG})"
make docker.pilot HUB=${HUB} TAG=${TAG}

echo "==> Loading image into kind"
kind load docker-image ${HUB}/pilot:${TAG} --name istio-dev

echo "==> Updating Istiod deployment"
kubectl set image deployment/istiod \
  -n istio-system \
  discovery=${HUB}/pilot:${TAG}

echo "==> Waiting for rollout"
kubectl rollout status deployment/istiod -n istio-system --timeout=120s

echo "==> Istiod restarted. Checking proxy config in 5s..."
sleep 5
istioctl proxy-config routes deploy/httpbin -o json | head -30

echo "==> Done"
```

```bash
chmod +x dev-loop.sh
./dev-loop.sh
```

## Debugging Tips

### Attach a Debugger to Istiod

For deeper debugging, you can run Istiod with Delve:

```bash
# Build with debug symbols (disable optimizations)
go build -gcflags="all=-N -l" -o out/pilot-discovery ./pilot/cmd/pilot-discovery

# In a separate terminal, port-forward to Istiod
kubectl port-forward -n istio-system deploy/istiod 15014:15014 8080:8080
```

Alternatively, run Istiod outside the cluster for maximum debug flexibility:

```bash
# Run Istiod locally, pointing at your kind cluster's kubeconfig
./out/pilot-discovery discovery \
  --kubeconfig=$HOME/.kube/config \
  --meshConfig=manifests/mesh/mesh.yaml
```

### Watch xDS Pushes in Real Time

```bash
# Use istioctl to watch xDS sync status
istioctl proxy-status

# Example output:
# NAME              CLUSTER   CDS   LDS   EDS   RDS   ECDS  ISTIOD
# httpbin-xxx       Kubernetes SYNCED SYNCED SYNCED SYNCED       istiod-xxx
# sleep-xxx         Kubernetes SYNCED SYNCED SYNCED SYNCED       istiod-xxx
```

### Inspect xDS Traffic with Envoy Admin API

```bash
# Port-forward to the Envoy admin interface on a sidecar
kubectl port-forward deploy/httpbin 15000:15000

# Then in another terminal:
# Full config dump
curl -s localhost:15000/config_dump | jq .

# Active clusters
curl -s localhost:15000/clusters

# Server info (shows Envoy version, uptime)
curl -s localhost:15000/server_info | jq .

# Stats with xDS metrics
curl -s localhost:15000/stats | grep "xds"

# Force a config reload from the control plane
curl -X POST localhost:15000/draining_listeners
```

### Enable Verbose Logging in Istiod

```bash
# Set Istiod log level dynamically (no restart needed)
kubectl exec -n istio-system deploy/istiod -- \
  curl -X PUT "localhost:8080/scopej/ads" \
  -d '{"output_level": "debug"}'

# Or set specific scopes:
# ads — xDS push/pull
# model — service model changes
# networking — listener/route/cluster generation

kubectl exec -n istio-system deploy/istiod -- \
  curl -X PUT "localhost:8080/scopej/networking" \
  -d '{"output_level": "debug"}'
```

## Common Changes and Where to Make Them

| What you want to change | Where in the code |
|---|---|
| Add/modify Envoy listeners | `pilot/pkg/networking/core/listener_builder.go` |
| Modify HTTP route generation | `pilot/pkg/networking/core/route/route.go` |
| Change cluster (upstream) config | `pilot/pkg/networking/core/cluster_builder.go` |
| Add a new xDS resource type | `pilot/pkg/xds/ads.go`, `pilot/pkg/xds/delta.go` |
| Modify mTLS/cert behavior | `pilot/pkg/security/` |
| Change service discovery | `pilot/pkg/serviceregistry/kube/controller/` |
| Add a new feature flag | `pilot/pkg/features/pilot.go` |
| Modify sidecar injection | `pkg/kube/inject/` |
| Change Istiod startup/bootstrap | `pilot/pkg/bootstrap/server.go` |

## Cleaning Up

```bash
# Delete the kind cluster when done
kind delete cluster --name istio-dev

# Remove built artifacts
make clean
```

## Summary

The full development loop:

1. **Clone** the Istio repo and understand the source layout
2. **Create** a local kind cluster
3. **Make** your code change in `pilot/pkg/`
4. **Build** the Docker image with `make docker.pilot`
5. **Load** the image into kind
6. **Deploy** with `istioctl install` or `kubectl set image`
7. **Verify** with `istioctl proxy-config` and live traffic tests
8. **Iterate** using the `dev-loop.sh` script

Once this loop is second nature, you can confidently hack on any part of Istiod — from xDS generation to certificate management to service discovery — and see the results on real Envoy proxies in minutes.
