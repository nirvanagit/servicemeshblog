---
title: "Envoy config_dump Demystified: Follow the Packet Through Every Section"
date: 2026-03-14
draft: false
tags: ["envoy", "istio", "debugging", "xds", "operations"]
categories: ["operations"]
author: "Service Mesh Blog"
description: "Trace an HTTP request through every section of Envoy's config_dump — from iptables capture to upstream delivery — and learn which Istio resources control each piece."
ShowToc: true
TocOpen: false
---

## The Mental Model

Most guides to Envoy's `config_dump` list each section in isolation. That's useful for reference, but it doesn't help you *think* like the proxy. This guide takes a different approach: we follow an actual packet as Envoy processes it, and at each step we show you the config dump section that controls that step — along with the Istio resource that put it there.

By the end, you'll have a clear mental model: **packet arrives → listener catches it → filter chain matches → route selects a cluster → cluster resolves endpoints → secrets secure the connection → request reaches the upstream pod.**

```bash
# Grab the full config dump from a sidecar
kubectl exec deploy/my-app -c istio-proxy -- \
  curl -s localhost:15000/config_dump | jq . > dump.json

# Include endpoints (not in the default dump)
kubectl exec deploy/my-app -c istio-proxy -- \
  curl -s localhost:15000/config_dump?include_eds | jq . > dump-with-eds.json
```

---

## The Scenario

Let's trace a concrete request. Pod `frontend` in namespace `default` sends an HTTP request to `http://reviews:8080/api/ratings`. The `reviews` service has two versions (v1 and v2), and an Istio `VirtualService` splits traffic 80/20 between them.

Here's what happens, step by step.

---

## Step 0: Bootstrap — The Foundation

**Config dump section:** `BootstrapConfigDump`

Before any packet flows, Envoy needs to know who it is and where to get its configuration. The bootstrap is the static config loaded at startup — it never changes during the proxy's lifetime.

**Where it comes from:** The `pilot-agent` binary generates it from mesh config and pod annotations, writes it to `/etc/istio/proxy/envoy-rev.json`, and then starts Envoy.

### What's in it

```json
{
  "node": {
    "id": "sidecar~10.244.0.15~frontend-7b9f4d5c6-x2k9l.default~default.svc.cluster.local",
    "metadata": {
      "NAMESPACE": "default",
      "SERVICE_ACCOUNT": "frontend",
      "LABELS": { "app": "frontend", "version": "v1" },
      "ISTIO_VERSION": "1.24.0",
      "INTERCEPTION_MODE": "REDIRECT"
    }
  },
  "dynamic_resources": {
    "ads_config": {
      "api_type": "GRPC",
      "grpc_services": [{
        "envoy_grpc": { "cluster_name": "xds-grpc" }
      }]
    }
  },
  "static_resources": {
    "clusters": [
      { "name": "xds-grpc", "...": "connection to istiod" },
      { "name": "prometheus_stats", "...": "metrics" },
      { "name": "agent", "...": "pilot-agent health" }
    ]
  }
}
```

The critical piece is `node.metadata` — this is the proxy's identity card. Istiod reads these labels and the service account to decide what config to push. If your `DestinationRule` has a workload selector, it matches against these labels.

### Istio resource that controls it

| Bootstrap field | Controlled by |
|----------------|--------------|
| `node.metadata` | Pod labels, ServiceAccount, and `istio-sidecar-injector` ConfigMap |
| `tracing` | `MeshConfig.defaultConfig.tracing` |
| `stats_config` | `MeshConfig.defaultConfig.proxyStatsMatcher` |
| `static_resources` | `MeshConfig` and the injector template |

---

## Step 1: Packet Captured — The Listener

**Config dump section:** `ListenersConfigDump`

The `frontend` app calls `reviews:8080`. It doesn't know Envoy exists. The kernel's iptables rules (injected by `istio-init`) intercept the outbound connection and redirect it to Envoy's **virtualOutbound** listener on port `15001`.

### The catch-all listener

```json
{
  "name": "virtualOutbound",
  "address": {
    "socket_address": { "address": "0.0.0.0", "port_value": 15001 }
  },
  "use_original_dst": true
}
```

`use_original_dst: true` is the key. Envoy sees that the *original* destination was `10.96.45.123:8080` (the ClusterIP of the `reviews` Service) and hands the connection off to a more specific listener that matches that address and port.

### The per-port listener

Envoy has a dynamically-created listener for port 8080:

```json
{
  "name": "0.0.0.0_8080",
  "address": {
    "socket_address": { "address": "0.0.0.0", "port_value": 8080 }
  },
  "filter_chains": [
    {
      "filter_chain_match": {
        "transport_protocol": "raw_buffer",
        "application_protocols": ["http/1.1", "h2c"]
      },
      "filters": [{
        "name": "envoy.filters.network.http_connection_manager",
        "typed_config": {
          "stat_prefix": "outbound_0.0.0.0_8080",
          "rds": {
            "route_config_name": "8080",
            "config_source": { "ads": {} }
          },
          "http_filters": [
            { "name": "istio.metadata_exchange" },
            { "name": "envoy.filters.http.fault" },
            { "name": "envoy.filters.http.cors" },
            { "name": "envoy.filters.http.router" }
          ]
        }
      }]
    }
  ]
}
```

**Filter chain matching** is how Envoy decides what to do with the connection. It checks:

- **`transport_protocol`** — `tls` or `raw_buffer` (plaintext)
- **`application_protocols`** — `http/1.1`, `h2c`, `istio-peer-exchange`
- **`destination_port`** — for the `virtualInbound` listener
- **`server_names`** — SNI-based matching

The HTTP connection manager runs the HTTP filter chain (fault injection, CORS, etc.) and then consults the route config referenced by `rds.route_config_name: "8080"`.

### For inbound traffic

When a request arrives *at* this pod, it hits the `virtualInbound` listener on port `15006` instead. The filter chains here have separate entries for `tls` (mTLS) and `raw_buffer` (plaintext). Whether both exist or only `tls` depends on the `PeerAuthentication` policy:

| PeerAuthentication mode | Filter chains present |
|------------------------|----------------------|
| `PERMISSIVE` (default) | Both `tls` and `raw_buffer` |
| `STRICT` | Only `tls` |
| `DISABLE` | Only `raw_buffer` |

### Istio resources that control listeners

| Istio Resource | What it controls in the listener |
|---------------|--------------------------------|
| `Sidecar` | Which listeners get created. A `Sidecar` with `egress.hosts` limits outbound listeners to only the listed services, reducing memory. |
| `EnvoyFilter` | Add, remove, or patch any filter in the filter chain. Can inject custom HTTP filters or network filters. |
| `PeerAuthentication` | Controls whether the inbound listener accepts plaintext, mTLS, or both. |
| `Gateway` | For gateway proxies (not sidecars), controls which ports/hosts the listener binds to. |

**Example — Limiting outbound scope with `Sidecar`:**

```yaml
apiVersion: networking.istio.io/v1
kind: Sidecar
metadata:
  name: frontend-sidecar
  namespace: default
spec:
  workloadSelector:
    labels:
      app: frontend
  egress:
  - hosts:
    - "./reviews.default.svc.cluster.local"
    - "./ratings.default.svc.cluster.local"
    - "istio-system/*"
```

This means Envoy will only have outbound listeners and clusters for `reviews`, `ratings`, and anything in `istio-system`. Without this, Envoy gets a listener for *every* service in the mesh.

**Example — Injecting a custom filter with `EnvoyFilter`:**

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: custom-lua-filter
  namespace: default
spec:
  workloadSelector:
    labels:
      app: frontend
  configPatches:
  - applyTo: HTTP_FILTER
    match:
      context: SIDECAR_OUTBOUND
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
            subFilter:
              name: envoy.filters.http.router
    patch:
      operation: INSERT_BEFORE
      value:
        name: envoy.filters.http.lua
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
          inline_code: |
            function envoy_on_request(handle)
              handle:headers():add("x-custom-header", "from-frontend")
            end
```

---

## Step 2: Route Matched — Where Should This Request Go?

**Config dump section:** `RoutesConfigDump`

The listener's HTTP connection manager references route config `"8080"`. Envoy looks it up in the routes config dump to decide which upstream cluster should handle the request.

### The route table

```json
{
  "route_config": {
    "name": "8080",
    "virtual_hosts": [
      {
        "name": "reviews.default.svc.cluster.local:8080",
        "domains": [
          "reviews.default.svc.cluster.local",
          "reviews.default.svc.cluster.local:8080",
          "reviews",
          "reviews:8080",
          "reviews.default",
          "reviews.default:8080",
          "reviews.default.svc",
          "reviews.default.svc:8080",
          "10.96.45.123",
          "10.96.45.123:8080"
        ],
        "routes": [
          {
            "match": {
              "prefix": "/"
            },
            "route": {
              "weighted_clusters": {
                "clusters": [
                  {
                    "name": "outbound|8080|v1|reviews.default.svc.cluster.local",
                    "weight": 80
                  },
                  {
                    "name": "outbound|8080|v2|reviews.default.svc.cluster.local",
                    "weight": 20
                  }
                ]
              },
              "timeout": "15s",
              "retry_policy": {
                "retry_on": "connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes",
                "num_retries": 2,
                "retry_host_predicate": [{ "name": "envoy.retry_host_predicates.previous_hosts" }]
              }
            }
          }
        ]
      }
    ]
  }
}
```

Here's the processing:

1. **Virtual host matching**: Envoy takes the `Host` header from the HTTP request (`reviews:8080`) and matches it against the `domains` list. The entry `"reviews:8080"` matches.
2. **Route matching**: Envoy walks the `routes` array in order and picks the first match. Our request path `/api/ratings` matches `prefix: "/"`.
3. **Cluster selection**: The route uses `weighted_clusters` — 80% of requests go to the `v1` subset cluster, 20% to `v2`. Envoy randomly selects one based on these weights.

Let's say this request was selected for `v2`.

### Istio resources that control routes

| Istio Resource | What it controls in routes |
|---------------|--------------------------|
| `VirtualService` | Route match rules, traffic splitting weights, timeouts, retries, fault injection, header manipulation, rewrites, mirroring |
| `Kubernetes Service` | Istio auto-generates a default route for every Service (prefix `/` → the service's cluster). VirtualService overrides this. |

**Example — The VirtualService that created our weighted route:**

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews-routing
  namespace: default
spec:
  hosts:
  - reviews
  http:
  - route:
    - destination:
        host: reviews
        subset: v1
        port:
          number: 8080
      weight: 80
    - destination:
        host: reviews
        subset: v2
        port:
          number: 8080
      weight: 20
    timeout: 15s
    retries:
      attempts: 2
      retryOn: connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes
```

**Example — Header-based routing (canary for a specific user):**

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews-canary
spec:
  hosts:
  - reviews
  http:
  - match:
    - headers:
        end-user:
          exact: jason
    route:
    - destination:
        host: reviews
        subset: v2
  - route:
    - destination:
        host: reviews
        subset: v1
```

This produces two route entries in the config dump. The header match route comes first (first match wins), and the catch-all default route follows.

**Example — Fault injection for testing:**

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews-fault
spec:
  hosts:
  - reviews
  http:
  - fault:
      delay:
        percentage:
          value: 10
        fixedDelay: 5s
      abort:
        percentage:
          value: 5
        httpStatus: 503
    route:
    - destination:
        host: reviews
```

This shows up in the route's `typed_per_filter_config` for the fault filter, not as a separate route.

---

## Step 3: Cluster Resolved — How to Reach the Upstream

**Config dump section:** `ClustersConfigDump`

The route selected cluster `outbound|8080|v2|reviews.default.svc.cluster.local`. Envoy now looks up this cluster to determine *how* to connect: what protocol, what TLS settings, what load balancing policy, what circuit breaker thresholds.

### Cluster naming convention

Istio uses the format `direction|port|subset|FQDN`:

| Example | Meaning |
|---------|---------|
| `outbound\|8080\|\|reviews.default.svc.cluster.local` | Outbound, port 8080, no subset |
| `outbound\|8080\|v2\|reviews.default.svc.cluster.local` | Outbound, port 8080, subset v2 |
| `inbound\|8080\|\|` | Inbound to this pod's port 8080 |
| `BlackHoleCluster` | No matching route — traffic dropped |
| `PassthroughCluster` | Unknown destination — forwarded as-is (controlled by `OutboundTrafficPolicy`) |

### The cluster config

```json
{
  "cluster": {
    "name": "outbound|8080|v2|reviews.default.svc.cluster.local",
    "type": "EDS",
    "eds_cluster_config": {
      "service_name": "outbound|8080|v2|reviews.default.svc.cluster.local"
    },
    "connect_timeout": "10s",
    "lb_policy": "ROUND_ROBIN",
    "circuit_breakers": {
      "thresholds": [{
        "max_connections": 100,
        "max_pending_requests": 1024,
        "max_requests": 1024,
        "max_retries": 3
      }]
    },
    "outlier_detection": {
      "consecutive_5xx": 5,
      "interval": "10s",
      "base_ejection_time": "30s",
      "max_ejection_percent": 50
    },
    "transport_socket": {
      "name": "envoy.transport_sockets.tls",
      "typed_config": {
        "common_tls_context": {
          "tls_certificate_sds_secret_configs": [{
            "name": "default",
            "sds_config": { "api_config_source": { "api_type": "GRPC" } }
          }],
          "combined_validation_context": {
            "default_validation_context": {
              "match_subject_alt_names": [{
                "exact": "spiffe://cluster.local/ns/default/sa/reviews"
              }]
            },
            "validation_context_sds_secret_config": {
              "name": "ROOTCA"
            }
          }
        }
      }
    },
    "metadata": {
      "filter_metadata": {
        "istio": {
          "config": "/apis/networking.istio.io/v1/namespaces/default/destination-rule/reviews-dr"
        }
      }
    }
  }
}
```

Key things Envoy now knows about this upstream:

- **`type: EDS`** — endpoints come dynamically from istiod (next step)
- **`lb_policy: ROUND_ROBIN`** — how to pick among endpoints
- **`circuit_breakers`** — if more than 100 connections are open, new ones are rejected
- **`outlier_detection`** — if an endpoint returns 5 consecutive 5xx errors, eject it for 30s
- **`transport_socket`** — use mTLS; validate that the upstream's cert has the SPIFFE ID `spiffe://cluster.local/ns/default/sa/reviews`
- **`metadata.filter_metadata.istio.config`** — breadcrumb back to the `DestinationRule` that created this config

### Istio resources that control clusters

| Istio Resource | What it controls in the cluster |
|---------------|-------------------------------|
| `DestinationRule` | Subsets, load balancing policy, circuit breakers, outlier detection, connection pool settings, TLS mode |
| `PeerAuthentication` | Whether the `transport_socket` uses mTLS. In `STRICT` mode, the cluster always has a TLS transport socket. |
| `MeshConfig` | `outboundTrafficPolicy` controls whether `PassthroughCluster` or `BlackHoleCluster` is used for unknown destinations. `connectTimeout` sets the default. |

**Example — The DestinationRule that created our subsets and circuit breakers:**

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-dr
  namespace: default
spec:
  host: reviews.default.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: DEFAULT
        http1MaxPendingRequests: 1024
        http2MaxRequests: 1024
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
    loadBalancer:
      simple: ROUND_ROBIN
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

Without this `DestinationRule`, the subset clusters (`outbound|8080|v1|...` and `outbound|8080|v2|...`) would not exist, and the `VirtualService` would have nowhere to route.

**Example — Locality-aware load balancing:**

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-locality
spec:
  host: reviews.default.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      localityLbSetting:
        enabled: true
        failover:
        - from: us-east-1
          to: us-west-2
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
```

This changes the `lb_policy` in the cluster config and adds locality-weighted endpoint assignments in EDS.

---

## Step 4: Endpoints Resolved — Which Pod Gets the Request?

**Config dump section:** `EndpointsConfigDump` (EDS)

The cluster says `type: EDS`, so Envoy looks up the endpoints for `outbound|8080|v2|reviews.default.svc.cluster.local`. These are the actual pod IPs that match the `v2` subset's label selector (`version: v2`).

> **Note:** Endpoints are not included in the default `config_dump`. You need `?include_eds`:
>
> ```bash
> curl -s localhost:15000/config_dump?include_eds | jq .
> ```

### The endpoint assignment

```json
{
  "cluster_name": "outbound|8080|v2|reviews.default.svc.cluster.local",
  "endpoints": [
    {
      "locality": {
        "region": "us-east-1",
        "zone": "us-east-1a"
      },
      "lb_endpoints": [
        {
          "endpoint": {
            "address": {
              "socket_address": {
                "address": "10.244.1.47",
                "port_value": 8080
              }
            }
          },
          "health_status": "HEALTHY",
          "metadata": {
            "filter_metadata": {
              "istio": {
                "workload": "reviews;default;reviews-v2-6c5d8f7b9-abc12;v2"
              }
            }
          },
          "load_balancing_weight": 1
        },
        {
          "endpoint": {
            "address": {
              "socket_address": {
                "address": "10.244.2.31",
                "port_value": 8080
              }
            }
          },
          "health_status": "HEALTHY",
          "load_balancing_weight": 1
        }
      ]
    }
  ]
}
```

Envoy's load balancer (ROUND_ROBIN, as specified by the cluster) picks one of these endpoints. Let's say it picks `10.244.1.47:8080`.

### What controls endpoints

Endpoints come from Kubernetes, not from Istio resources directly:

| Source | What it controls |
|--------|-----------------|
| `Kubernetes Service` + `Endpoints`/`EndpointSlice` | The set of pod IPs. Istiod watches these and pushes them via EDS. |
| `DestinationRule` subsets | Filter endpoints by label. The v2 subset only includes pods with `version: v2`. |
| `DestinationRule` outlier detection | Marks endpoints as `UNHEALTHY` at runtime when error thresholds are exceeded. |
| `WorkloadEntry` / `ServiceEntry` | For VMs or external services not in Kubernetes. These create synthetic endpoints. |

**Example — Adding an external VM as an endpoint:**

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: reviews-vm
spec:
  hosts:
  - reviews-legacy.default.svc.cluster.local
  ports:
  - number: 8080
    name: http
    protocol: HTTP
  resolution: STATIC
  endpoints:
  - address: 192.168.1.50
    labels:
      version: v1
```

This creates a cluster with a statically-defined endpoint at `192.168.1.50:8080` — visible in both the ClustersConfigDump and EndpointsConfigDump.

---

## Step 5: Secure the Connection — mTLS Handshake

**Config dump section:** `SecretsConfigDump`

Before sending the request, Envoy needs to establish a TLS connection to the upstream pod. The cluster's `transport_socket` told Envoy to use mTLS with the `default` certificate and validate the peer against `ROOTCA`.

### The secrets

```json
{
  "@type": "type.googleapis.com/envoy.admin.v3.SecretsConfigDump",
  "dynamic_active_secrets": [
    {
      "name": "default",
      "secret": {
        "tls_certificate": {
          "certificate_chain": { "inline_bytes": "..." },
          "private_key": { "inline_bytes": "[redacted]" }
        }
      }
    },
    {
      "name": "ROOTCA",
      "secret": {
        "validation_context": {
          "trusted_ca": { "inline_bytes": "..." }
        }
      }
    }
  ]
}
```

| Secret | Purpose |
|--------|---------|
| `default` | This proxy's own X.509 certificate and private key. The SAN contains the SPIFFE ID: `spiffe://cluster.local/ns/default/sa/frontend` |
| `ROOTCA` | The mesh root CA cert. Used to validate the upstream's certificate during the TLS handshake. |

The handshake flow:

1. **Frontend's Envoy** presents its `default` cert to the upstream
2. **Reviews' Envoy** validates it against its own `ROOTCA`
3. **Reviews' Envoy** presents its `default` cert back
4. **Frontend's Envoy** validates it against `ROOTCA` **and** checks that the SAN matches `spiffe://cluster.local/ns/default/sa/reviews` (as specified in the cluster's `match_subject_alt_names`)

### Inspecting certificates

```bash
# Decode the workload certificate
kubectl exec deploy/frontend -c istio-proxy -- \
  curl -s localhost:15000/config_dump?resource=dynamic_active_secrets | \
  jq -r '.configs[0].dynamic_active_secrets[0].secret.tls_certificate.certificate_chain.inline_bytes' | \
  base64 -d | openssl x509 -text -noout
```

Check these fields:
- **Subject Alternative Name**: `URI:spiffe://cluster.local/ns/default/sa/frontend`
- **Not After**: Certificates rotate every 24 hours by default
- **Issuer**: Should match your Istio CA

### Istio resources that control secrets

| Istio Resource | What it controls |
|---------------|-----------------|
| `PeerAuthentication` | Whether mTLS is required, permissive, or disabled. Controls whether the `transport_socket` appears on clusters and listener filter chains. |
| `DestinationRule` `trafficPolicy.tls.mode` | Client-side TLS mode for a specific destination: `ISTIO_MUTUAL`, `MUTUAL`, `SIMPLE`, `DISABLE`. |
| `RequestAuthentication` | JWT validation — adds a JWT filter to the listener's HTTP filter chain (not in secrets, but related to auth). |
| `MeshConfig` | CA address, cert lifetime, trust domain. |

**Example — Strict mTLS enforcement:**

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: default
spec:
  mtls:
    mode: STRICT
```

With `STRICT`, the `virtualInbound` listener will only have filter chains matching `transport_protocol: "tls"`. Plaintext connections are rejected. Without it (default `PERMISSIVE`), both TLS and plaintext filter chains exist.

**Example — Enforcing STRICT per-port:**

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: reviews-auth
  namespace: default
spec:
  selector:
    matchLabels:
      app: reviews
  mtls:
    mode: PERMISSIVE
  portLevelMtls:
    8080:
      mode: STRICT
```

---

## Step 6: Request Delivered

At this point, the packet has traversed the entire Envoy pipeline:

```
┌─────────────────────────────────────────────────────────────────────┐
│  frontend pod                                                       │
│                                                                     │
│  App → HTTP to reviews:8080                                         │
│    │                                                                │
│    ▼                                                                │
│  iptables REDIRECT → 0.0.0.0:15001                                 │
│    │                                                                │
│    ▼                                                                │
│  LISTENER: virtualOutbound (use_original_dst=true)                  │
│    │         Controlled by: Sidecar, EnvoyFilter                    │
│    ▼                                                                │
│  LISTENER: 0.0.0.0_8080 → filter chain match                       │
│    │         Controlled by: Sidecar, EnvoyFilter, PeerAuthentication│
│    ▼                                                                │
│  ROUTE: "8080" → virtual host "reviews:8080" → weighted_clusters   │
│    │         Controlled by: VirtualService                          │
│    ▼                                                                │
│  CLUSTER: outbound|8080|v2|reviews.default.svc.cluster.local       │
│    │         Controlled by: DestinationRule                         │
│    ▼                                                                │
│  ENDPOINTS: 10.244.1.47:8080 (HEALTHY)                             │
│    │         Controlled by: K8s Service/Endpoints, DestinationRule  │
│    ▼                                                                │
│  SECRETS: mTLS with "default" cert, validated against "ROOTCA"      │
│    │         Controlled by: PeerAuthentication, DestinationRule     │
│    ▼                                                                │
│  TCP connection to 10.244.1.47:8080 with TLS                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  reviews-v2 pod (10.244.1.47)                                      │
│                                                                     │
│  iptables REDIRECT → 0.0.0.0:15006                                 │
│    │                                                                │
│    ▼                                                                │
│  LISTENER: virtualInbound → filter chain match (tls, port 8080)    │
│    │         Controlled by: PeerAuthentication, AuthorizationPolicy │
│    ▼                                                                │
│  ROUTE: inbound|8080 → cluster inbound|8080||                      │
│    ▼                                                                │
│  App receives request on localhost:8080                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## ScopedRoutesConfigDump

One section we skipped: `ScopedRoutesConfigDump`. This allows Envoy to select different route tables based on connection properties. In practice, it's **always empty** in Istio deployments — Istio uses inline route configs or RDS references instead. You can safely ignore it.

---

## Complete Mapping: Istio Resources → Config Dump

Here's the full reference of every Istio resource and exactly which config dump section it affects:

| Istio Resource | Config Dump Section | What It Controls |
|---------------|-------------------|-----------------|
| **VirtualService** | Routes | Route match rules, traffic splitting, timeouts, retries, fault injection, rewrites, mirroring, header manipulation |
| **DestinationRule** | Clusters | Subsets, load balancing, circuit breakers, outlier detection, connection pools, client TLS mode |
| **DestinationRule** | Endpoints | Subset label filtering determines which endpoints appear in each subset cluster |
| **PeerAuthentication** | Listeners (inbound) | Whether inbound filter chains accept TLS, plaintext, or both |
| **PeerAuthentication** | Clusters + Secrets | Whether outbound clusters use mTLS transport sockets |
| **AuthorizationPolicy** | Listeners (inbound) | Adds RBAC filter to inbound HTTP filter chain. Allows/denies requests based on source identity, paths, methods |
| **RequestAuthentication** | Listeners (inbound) | Adds JWT authn filter to inbound HTTP filter chain |
| **Sidecar** | Listeners + Clusters | Scopes which outbound listeners/clusters exist. Reduces config size. |
| **EnvoyFilter** | Any section | Direct patches to any part of the config: add/remove/modify listeners, clusters, routes, filters |
| **ServiceEntry** | Clusters + Endpoints | Creates clusters and endpoints for external services or VMs |
| **WorkloadEntry** | Endpoints | Adds non-Kubernetes endpoints (VMs) to a service's endpoint list |
| **Gateway** | Listeners | For gateway proxies: which ports/hosts/TLS certs to bind |
| **MeshConfig** | Bootstrap + all | Global defaults: outbound traffic policy, tracing, access logging, proxy concurrency, default timeouts |
| **Telemetry** | Listeners | Access logging, tracing, and metrics filters in the filter chain |

---

## Debugging Cheat Sheet

| Symptom | Config dump section | What to check |
|---------|-------------------|---------------|
| 503 upstream connect error | Clusters → Secrets | Does the cluster exist? Are endpoints healthy? Are certs valid and not expired? |
| 404 not found | Routes | Does a virtual host match the `Host` header? Does a route match the path? |
| Connection refused | Listeners → Endpoints | Is there a listener on that port? Is the pod IP in the endpoint list? |
| Traffic not splitting | Routes → Clusters | Are `weighted_clusters` present? Do the subset clusters exist (requires DestinationRule)? |
| mTLS handshake failure | Secrets → Clusters | Check cert expiry, ROOTCA match, and `match_subject_alt_names` on the cluster. |
| Request rejected (RBAC) | Listeners (inbound) | Check the `envoy.filters.http.rbac` filter config. Look for `AuthorizationPolicy` deny rules. |
| Circuit breaker tripping | Clusters | Compare `circuit_breakers.thresholds` against live stats at `/clusters`. |
| Wrong retry/timeout | Routes | Check `retry_policy` and `timeout` on the matched route. |
| Config not updating | Any | Compare `version_info` across sections. If stale, check istiod connectivity (`xds-grpc` cluster in bootstrap). |

---

## Useful Admin Endpoints Beyond config_dump

```bash
# Live cluster stats (connections, success/error counts, health)
curl localhost:15000/clusters

# Listener state
curl localhost:15000/listeners

# Proxy sync status
curl localhost:15000/server_info

# Prometheus metrics
curl localhost:15000/stats/prometheus

# Toggle debug logging for a specific component
curl -X POST "localhost:15000/logging?connection=debug"
curl -X POST "localhost:15000/logging?http=debug"

# Check what istiod pushed (proxy-status equivalent)
istioctl proxy-status
istioctl proxy-config all deploy/frontend -o json
```

---

## Using istioctl to Read the Config Dump

You don't have to parse raw JSON yourself. `istioctl proxy-config` gives you a human-readable view of each config dump section, and `istioctl analyze` can catch misconfigurations before they reach the proxy.

### Inspect listeners (LDS)

```bash
# List all listeners on frontend's sidecar
istioctl proxy-config listeners deploy/frontend

# Detailed JSON output for a specific listener
istioctl proxy-config listeners deploy/frontend --port 8080 -o json

# Show only the filter chains and their matches
istioctl proxy-config listeners deploy/frontend --port 15006 -o json | \
  jq '.[].filterChains[] | {match: .filterChainMatch, filters: [.filters[].name]}'
```

Example output of `istioctl proxy-config listeners`:
```
ADDRESS        PORT  MATCH                        DESTINATION
0.0.0.0        8080  ALL                          Route: 8080
0.0.0.0        15001 ALL                          PassthroughCluster
0.0.0.0        15006 ALL                          Inline Route
0.0.0.0        15010 ALL                          Inline Route
10.96.0.1      443   ALL                          Cluster: outbound|443||kubernetes.default.svc.cluster.local
10.96.0.10     53    ALL                          Cluster: outbound|53||kube-dns.kube-system.svc.cluster.local
```

### Inspect routes (RDS)

```bash
# List all route configs
istioctl proxy-config routes deploy/frontend

# Show the route table for port 8080
istioctl proxy-config routes deploy/frontend --name 8080 -o json

# Find which route matches a specific request
istioctl proxy-config routes deploy/frontend --name 8080 -o json | \
  jq '.[].virtualHosts[] | select(.domains[] | contains("reviews"))'
```

Example output of `istioctl proxy-config routes`:
```
NAME     DOMAINS                                          MATCH     VIRTUAL SERVICE
8080     reviews.default.svc.cluster.local                /*        reviews-routing.default
8080     ratings.default.svc.cluster.local                /*
80       istio-ingressgateway.istio-system                /*
```

The `VIRTUAL SERVICE` column tells you which Istio resource created each route — critical for tracing config back to its source.

### Inspect clusters (CDS)

```bash
# List all clusters
istioctl proxy-config clusters deploy/frontend

# Filter by a specific service
istioctl proxy-config clusters deploy/frontend --fqdn reviews.default.svc.cluster.local

# Full JSON for a subset cluster
istioctl proxy-config clusters deploy/frontend \
  --fqdn reviews.default.svc.cluster.local --subset v2 -o json

# Show only clusters with a specific DestinationRule
istioctl proxy-config clusters deploy/frontend -o json | \
  jq '.[] | select(.metadata.filterMetadata.istio.config | contains("reviews-dr"))'
```

Example output of `istioctl proxy-config clusters`:
```
SERVICE FQDN                                PORT  SUBSET  DIRECTION   TYPE  DESTINATION RULE
reviews.default.svc.cluster.local           8080  -       outbound    EDS   reviews-dr.default
reviews.default.svc.cluster.local           8080  v1      outbound    EDS   reviews-dr.default
reviews.default.svc.cluster.local           8080  v2      outbound    EDS   reviews-dr.default
BlackHoleCluster                            -     -       -           STATIC
PassthroughCluster                          -     -       -           ORIGINAL_DST
```

Notice how the `DESTINATION RULE` column maps each cluster back to the Istio resource that configured it.

### Inspect endpoints (EDS)

```bash
# List all endpoints for a service
istioctl proxy-config endpoints deploy/frontend \
  --cluster "outbound|8080|v2|reviews.default.svc.cluster.local"

# Show all endpoints with their health status
istioctl proxy-config endpoints deploy/frontend --port 8080

# Find unhealthy endpoints
istioctl proxy-config endpoints deploy/frontend -o json | \
  jq '.[] | select(.healthStatus != "HEALTHY")'
```

Example output:
```
ENDPOINT           STATUS      OUTLIER CHECK  CLUSTER
10.244.1.47:8080   HEALTHY     OK             outbound|8080|v2|reviews.default.svc.cluster.local
10.244.2.31:8080   HEALTHY     OK             outbound|8080|v2|reviews.default.svc.cluster.local
10.244.1.12:8080   UNHEALTHY   FAILED         outbound|8080|v1|reviews.default.svc.cluster.local
```

The `OUTLIER CHECK` column shows whether the endpoint has been ejected by outlier detection — a direct reflection of the `outlier_detection` settings in the cluster config.

### Inspect secrets (SDS)

```bash
# Show certificate details (expiry, SAN, issuer)
istioctl proxy-config secret deploy/frontend

# Full JSON with cert chain bytes
istioctl proxy-config secret deploy/frontend -o json
```

Example output:
```
RESOURCE NAME   TYPE           STATUS   VALID CERT  SERIAL NUMBER             NOT AFTER               NOT BEFORE
default         Cert Chain     ACTIVE   true        c9a4f83b2e1d7a0f...      2026-03-16T10:30:00Z    2026-03-15T10:28:00Z
ROOTCA          CA             ACTIVE   true        5e2f1a9c3b8d4e7f...      2036-03-13T10:00:00Z    2026-03-15T10:00:00Z
```

### Dump everything at once

```bash
# Full proxy config in JSON (all sections)
istioctl proxy-config all deploy/frontend -o json > frontend-proxy-config.json

# Compare two proxies side-by-side (useful for debugging why one works and another doesn't)
diff <(istioctl proxy-config clusters deploy/frontend -o json) \
     <(istioctl proxy-config clusters deploy/reviews-v2 -o json)
```

### Check sync status between istiod and proxies

```bash
# Are all proxies in sync with the control plane?
istioctl proxy-status

# Example output:
# NAME                          CDS    LDS    EDS    RDS    ECDS   ISTIOD                    VERSION
# frontend-7b9f4d5c6-x2k9l     SYNCED SYNCED SYNCED SYNCED        istiod-6f8d9c7b8-m4k2l    1.24.0
# reviews-v2-6c5d8f7b9-abc12   SYNCED SYNCED SYNCED SYNCED        istiod-6f8d9c7b8-m4k2l    1.24.0
```

If any column shows `STALE` instead of `SYNCED`, the proxy isn't receiving config updates. Check the `xds-grpc` cluster in bootstrap and look for connectivity issues to istiod.

### Analyze configuration for errors

```bash
# Analyze the entire mesh for misconfigurations
istioctl analyze

# Analyze a specific namespace
istioctl analyze -n default

# Analyze before applying (dry-run a YAML file)
istioctl analyze my-virtualservice.yaml

# Example output:
# Warning [IST0101] (VirtualService reviews-routing.default)
#   Referenced host not found: "reviews" in namespace "default"
# Warning [IST0108] (DestinationRule reviews-dr.default)
#   This DestinationRule is not used. No matching VirtualService found.
# Info [IST0102] (Namespace default)
#   The namespace is not enabled for Istio injection.
```

`istioctl analyze` catches the misconfigurations that would otherwise only surface as silent config dump anomalies — missing subsets, orphaned VirtualServices, port conflicts, and more.

### The nuclear option: full xDS debug

When nothing else works, you can see exactly what istiod is computing for a specific proxy:

```bash
# See the xDS resources istiod would push to a specific proxy
istioctl proxy-config all deploy/frontend -o json > what-envoy-has.json

# Compare with what istiod thinks it should push
kubectl exec -n istio-system deploy/istiod -- \
  curl -s "localhost:15014/debug/config_dump?proxyID=sidecar~10.244.0.15~frontend-7b9f4d5c6-x2k9l.default~default.svc.cluster.local" \
  > what-istiod-wants-to-push.json

diff what-envoy-has.json what-istiod-wants-to-push.json
```

---

The config dump is Envoy's entire brain, laid bare. Once you can trace a packet through listeners → routes → clusters → endpoints → secrets, and map each section back to the Istio resource that controls it, you'll never feel lost debugging a service mesh issue again.
