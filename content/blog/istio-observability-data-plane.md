---
title: "Istio Observability Series (1/2): Golden Signals for the Data Plane — HTTP, TLS, and gRPC"
date: 2026-03-25
draft: false
tags: ["istio", "envoy", "observability", "prometheus", "grafana", "metrics"]
categories: ["observability"]
author: "Service Mesh Blog"
description: "Part 1 of our observability series. The golden signals you should monitor for Istio's data plane — broken down by HTTP, TLS, and gRPC protocols. Specific Prometheus metrics, PromQL queries, and production alert rules."
ShowToc: true
TocOpen: false
---

> *This is **Part 1 of 2** in the Istio Observability series. This post covers the **data plane** (Envoy sidecars). [Part 2 covers the **control plane** (istiod)](/blog/istio-observability-control-plane/).*

---

## Why Golden Signals for the Data Plane?

Google's SRE book defined the **four golden signals** — latency, traffic, errors, and saturation — as the minimum set of metrics you need to understand the health of any system.

In Istio's data plane, every request between services passes through Envoy sidecars that emit rich telemetry. But the signals aren't one-size-fits-all — **different protocols expose different dimensions**:

- **HTTP** gives you status codes, request duration, and body sizes
- **TLS** gives you handshake metrics, certificate errors, and session reuse
- **gRPC** has its own status code system that hides behind HTTP 200, plus streaming semantics that break traditional RPS metrics

This post breaks down all four golden signals for each protocol, with the exact Prometheus metrics, PromQL queries, and alert rules you need for production.

---

## HTTP Protocol

HTTP traffic is the most common in a service mesh. Envoy emits detailed L7 metrics for every HTTP request/response.

### Golden Signal 1: Latency

**What it measures:** How long it takes for the upstream service to respond to an HTTP request, as observed by the sidecar.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_request_duration_milliseconds` | Histogram | Request duration from the Envoy sidecar's perspective |
| `envoy_cluster_upstream_rq_time` | Histogram | Time from Envoy sending the request upstream to receiving the first byte of the response |

**PromQL queries:**

```promql
# P50 latency for a specific service (server-side, inbound)
histogram_quantile(0.50,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    destination_service_name="my-service",
    request_protocol="http"
  }[5m])) by (le)
)

# P99 latency (the tail that catches slowdowns)
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    destination_service_name="my-service",
    request_protocol="http"
  }[5m])) by (le)
)

# P99 latency broken down by source → destination
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    request_protocol="http"
  }[5m])) by (le, source_workload, destination_workload)
)
```

**What to alert on:**

```yaml
# Alert: P99 latency exceeds 500ms for 5 minutes
- alert: HighP99Latency
  expr: |
    histogram_quantile(0.99,
      sum(rate(istio_request_duration_milliseconds_bucket{
        reporter="destination",
        request_protocol="http"
      }[5m])) by (le, destination_service_name)
    ) > 500
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High P99 latency on {{ $labels.destination_service_name }}"
```

**Important nuance:** Istio reports latency from **two perspectives**:
- `reporter="source"` — measured by the **client-side** sidecar (includes network latency + server processing)
- `reporter="destination"` — measured by the **server-side** sidecar (mostly server processing time)

The difference between source and destination latency tells you how much time is spent in the network (including mTLS handshake overhead).

---

### Golden Signal 2: Traffic (Throughput)

**What it measures:** The volume of HTTP requests flowing through the mesh.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Total count of requests, labeled by source, destination, response code, method |
| `istio_request_bytes` | Histogram | Request body size in bytes |
| `istio_response_bytes` | Histogram | Response body size in bytes |

**PromQL queries:**

```promql
# Requests per second to a service
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  request_protocol="http"
}[5m]))

# RPS broken down by HTTP method
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  request_protocol="http"
}[5m])) by (request_method)

# Bandwidth: bytes/sec received by a service
sum(rate(istio_request_bytes_sum{
  reporter="destination",
  destination_service_name="my-service"
}[5m]))

# Top 10 busiest service-to-service edges
topk(10,
  sum(rate(istio_requests_total{reporter="source"}[5m]))
    by (source_workload, destination_workload)
)
```

**What to alert on:**

```yaml
# Alert: Traffic drop > 50% compared to same time last week
- alert: TrafficDrop
  expr: |
    sum(rate(istio_requests_total{
      reporter="destination",
      destination_service_name="my-service"
    }[5m]))
    /
    sum(rate(istio_requests_total{
      reporter="destination",
      destination_service_name="my-service"
    }[5m] offset 7d))
    < 0.5
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "Traffic to {{ $labels.destination_service_name }} dropped >50% vs last week"
```

---

### Golden Signal 3: Errors

**What it measures:** The rate of failed HTTP requests — 4xx client errors and 5xx server errors.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Labeled with `response_code` (200, 404, 500, etc.) and `response_flags` |
| `envoy_cluster_upstream_rq_xx` | Counter | Aggregated by response class (2xx, 4xx, 5xx) |

**PromQL queries:**

```promql
# Error rate (5xx only) as a percentage
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  response_code=~"5.*",
  request_protocol="http"
}[5m]))
/
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  request_protocol="http"
}[5m])) * 100

# Error rate broken down by response code
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  response_code=~"[45].*"
}[5m])) by (response_code)

# Errors caused by Envoy itself (not the upstream)
# response_flags tells you WHY a request failed
sum(rate(istio_requests_total{
  reporter="destination",
  destination_service_name="my-service",
  response_flags!=""
}[5m])) by (response_flags)
```

**Envoy response flags you should know:**

| Flag | Meaning | Indicates |
|------|---------|-----------|
| `UH` | No healthy upstream | All endpoints are unhealthy |
| `UF` | Upstream connection failure | TCP connect failed |
| `UT` | Upstream request timeout | Request exceeded timeout |
| `UC` | Upstream connection termination | Connection reset mid-request |
| `NR` | No route configured | Missing VirtualService or routing rule |
| `URX` | Upstream retry limit exceeded | All retries exhausted |
| `DC` | Downstream connection termination | Client disconnected |
| `RL` | Rate limited | Local or global rate limit hit |

**What to alert on:**

```yaml
# Alert: 5xx error rate exceeds 1% for 5 minutes
- alert: HighErrorRate
  expr: |
    (
      sum(rate(istio_requests_total{
        reporter="destination",
        response_code=~"5.*",
        request_protocol="http"
      }[5m])) by (destination_service_name)
      /
      sum(rate(istio_requests_total{
        reporter="destination",
        request_protocol="http"
      }[5m])) by (destination_service_name)
    ) > 0.01
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "5xx error rate >1% on {{ $labels.destination_service_name }}"
```

---

### Golden Signal 4: Saturation

**What it measures:** How close the data plane is to its resource limits.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `envoy_cluster_upstream_cx_active` | Gauge | Active connections to upstream |
| `envoy_cluster_upstream_cx_overflow` | Counter | Connection pool overflows (circuit breaker tripped) |
| `envoy_cluster_upstream_rq_pending_active` | Gauge | Requests waiting for a connection |
| `envoy_cluster_upstream_rq_pending_overflow` | Counter | Requests rejected due to pending limit |
| `envoy_server_memory_allocated` | Gauge | Envoy process memory usage |
| `envoy_server_concurrency` | Gauge | Number of worker threads |

**PromQL queries:**

```promql
# Connection pool utilization per cluster
envoy_cluster_upstream_cx_active{
  cluster_name="outbound|8080||my-service.default.svc.cluster.local"
}

# Circuit breaker trips (connection overflow)
sum(rate(envoy_cluster_upstream_cx_overflow{
  cluster_name=~"outbound.*my-service.*"
}[5m]))

# Pending request queue depth (requests waiting for a connection)
envoy_cluster_upstream_rq_pending_active{
  cluster_name=~"outbound.*my-service.*"
}

# Envoy memory usage per pod
envoy_server_memory_allocated / 1024 / 1024  # in MB
```

**What to alert on:**

```yaml
# Alert: Circuit breaker is tripping (connection overflow)
- alert: CircuitBreakerTripping
  expr: |
    sum(rate(envoy_cluster_upstream_cx_overflow[5m]))
      by (pod, cluster_name) > 0
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "Circuit breaker overflow on {{ $labels.pod }} for {{ $labels.cluster_name }}"

# Alert: Envoy memory usage exceeds 200MB
- alert: EnvoyHighMemory
  expr: envoy_server_memory_allocated > 200 * 1024 * 1024
  for: 10m
  labels:
    severity: warning
```

---

## HTTPS / TLS Protocol

When traffic is encrypted (either mTLS between sidecars or TLS origination to external services), additional metrics become critical. TLS failures are one of the most common issues in a service mesh, and without the right signals they are invisible.

### Golden Signal 1: Latency

TLS adds handshake overhead on top of HTTP latency. You need to measure both.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_request_duration_milliseconds` | Histogram | Same as HTTP — includes TLS termination time |
| `envoy_listener_ssl_handshake_duration` | Histogram | Time spent in the TLS handshake alone |
| `envoy_cluster_ssl_handshake` | Counter | Total TLS handshakes completed to upstream |

**PromQL queries:**

```promql
# mTLS handshake overhead: compare source vs destination latency
# The delta approximates network + TLS handshake time
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="source",
    destination_service_name="my-service"
  }[5m])) by (le)
)
-
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    destination_service_name="my-service"
  }[5m])) by (le)
)
```

**What to watch for:** If the source-destination latency gap is consistently >5ms, you may have TLS configuration issues (cipher negotiation, certificate chain validation), or the sidecar is doing too many new handshakes (check connection reuse).

---

### Golden Signal 2: Traffic

TLS traffic volume is best tracked through connection-level metrics since TLS operates at the connection layer.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `envoy_cluster_ssl_connection_error` | Counter | TLS connection failures |
| `envoy_listener_ssl_connection_error` | Counter | Inbound TLS connection failures |
| `envoy_cluster_upstream_cx_total` | Counter | Total connections (TLS and non-TLS) |

**PromQL queries:**

```promql
# New TLS connections per second (high rate = poor connection reuse)
sum(rate(envoy_cluster_ssl_handshake[5m])) by (pod)

# TLS connection reuse ratio
# Low ratio means many new handshakes (expensive)
1 - (
  rate(envoy_cluster_ssl_handshake[5m])
  /
  rate(istio_requests_total{reporter="source"}[5m])
)
```

---

### Golden Signal 3: Errors

TLS errors are distinct from HTTP errors — they happen **before** any HTTP exchange occurs.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `envoy_cluster_ssl_connection_error` | Counter | Outbound TLS handshake failures |
| `envoy_listener_ssl_connection_error` | Counter | Inbound TLS handshake failures |
| `envoy_cluster_ssl_fail_verify_san` | Counter | SAN verification failures (certificate doesn't match expected identity) |
| `envoy_cluster_ssl_fail_verify_cert_hash` | Counter | Certificate hash mismatch |
| `envoy_cluster_ssl_fail_verify_no_cert` | Counter | Peer didn't present a certificate (mTLS enforcement) |
| `istio_requests_total{response_flags="UF"}` | Counter | Upstream connection failures (often TLS-related) |

**PromQL queries:**

```promql
# TLS handshake failure rate
sum(rate(envoy_cluster_ssl_connection_error[5m])) by (pod)

# SAN verification failures (wrong identity / cert mismatch)
sum(rate(envoy_cluster_ssl_fail_verify_san[5m])) by (pod)

# Requests failing due to upstream connection failure (often TLS)
sum(rate(istio_requests_total{
  response_flags="UF",
  reporter="source"
}[5m])) by (source_workload, destination_workload)

# No-cert failures (client didn't present mTLS cert)
sum(rate(envoy_cluster_ssl_fail_verify_no_cert[5m])) by (pod)
```

**What to alert on:**

```yaml
# Alert: TLS handshake failures are occurring
- alert: TLSHandshakeFailures
  expr: |
    sum(rate(envoy_cluster_ssl_connection_error[5m])) by (pod) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "TLS handshake failures on {{ $labels.pod }}"

# Alert: SAN verification failures (certificate identity mismatch)
- alert: TLSSANVerificationFailure
  expr: |
    sum(rate(envoy_cluster_ssl_fail_verify_san[5m])) by (pod) > 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "TLS SAN verification failing on {{ $labels.pod }} — check certificate identities"
```

---

### Golden Signal 4: Saturation

TLS-specific saturation relates to certificate management and connection overhead.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `envoy_server_ssl_context_session_cache_hits` | Counter | TLS session cache hits (connection reuse) |
| `envoy_server_ssl_context_session_cache_misses` | Counter | TLS session cache misses (new handshakes) |

**PromQL queries:**

```promql
# TLS session cache hit ratio (higher = better, less handshake overhead)
sum(rate(envoy_server_ssl_context_session_cache_hits[5m])) by (pod)
/
(
  sum(rate(envoy_server_ssl_context_session_cache_hits[5m])) by (pod)
  +
  sum(rate(envoy_server_ssl_context_session_cache_misses[5m])) by (pod)
)
```

---

## gRPC Protocol

gRPC uses HTTP/2 under the hood, so it shares many HTTP metrics. But gRPC has its own status code system and streaming semantics that require dedicated signals.

### Golden Signal 1: Latency

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_request_duration_milliseconds` | Histogram | Same metric, filtered by `request_protocol="grpc"` |
| `envoy_cluster_grpc_upstream_rq_time` | Histogram | gRPC-specific upstream request time |

**PromQL queries:**

```promql
# P99 latency for gRPC services
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    destination_service_name="my-grpc-service",
    request_protocol="grpc"
  }[5m])) by (le)
)

# Latency by gRPC method (requires method to be in labels)
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    request_protocol="grpc"
  }[5m])) by (le, destination_service_name, request_path)
)
```

**gRPC latency nuance:** For **unary RPCs**, latency is straightforward — time from request to response. For **streaming RPCs**, `istio_request_duration_milliseconds` measures the **total stream duration**, which can be minutes or hours for long-lived streams. You need to interpret this differently:

```promql
# For streaming gRPC, track stream duration separately
# Long durations are NORMAL for streams — don't alert on these
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="destination",
    request_protocol="grpc",
    grpc_response_status="0"  # only successful streams
  }[5m])) by (le, destination_service_name)
)
```

---

### Golden Signal 2: Traffic

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Request count with `request_protocol="grpc"` |
| `envoy_cluster_grpc_total` | Counter | Total gRPC requests by cluster |
| `istio_request_messages_total` | Counter | Total gRPC messages sent (for streaming) |
| `istio_response_messages_total` | Counter | Total gRPC messages received (for streaming) |

**PromQL queries:**

```promql
# gRPC RPS by service
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc"
}[5m])) by (destination_service_name)

# gRPC message rate for streaming services
# (messages per second, not requests per second)
sum(rate(istio_request_messages_total{
  reporter="destination",
  destination_service_name="my-streaming-service"
}[5m]))

# gRPC traffic by method path
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc"
}[5m])) by (destination_service_name, request_path)
```

**Why message rate matters for gRPC:** A single gRPC stream can carry thousands of messages. If you only track `istio_requests_total`, you'll see 1 RPS for a stream that's processing 10,000 messages/sec. `istio_request_messages_total` and `istio_response_messages_total` give the true throughput.

---

### Golden Signal 3: Errors

gRPC has its own status code system that is **independent** of HTTP status codes. A gRPC error returns HTTP 200 with a gRPC status in the `grpc-status` trailer.

**gRPC status codes you must monitor:**

| Code | Name | Meaning |
|------|------|---------|
| 0 | OK | Success |
| 1 | CANCELLED | Client cancelled the request |
| 2 | UNKNOWN | Unknown error (often a panic in the server) |
| 4 | DEADLINE_EXCEEDED | Timeout |
| 5 | NOT_FOUND | Resource not found |
| 7 | PERMISSION_DENIED | Auth failed |
| 8 | RESOURCE_EXHAUSTED | Rate limited or quota exceeded |
| 13 | INTERNAL | Server bug |
| 14 | UNAVAILABLE | Service temporarily unavailable (retryable) |

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Labeled with `grpc_response_status` (0, 1, 2, ...) |
| `envoy_cluster_grpc_request_message_count` | Counter | gRPC messages sent |
| `envoy_cluster_grpc_response_message_count` | Counter | gRPC messages received |

**PromQL queries:**

```promql
# gRPC error rate (all non-OK status codes)
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc",
  grpc_response_status!="0"
}[5m])) by (destination_service_name)
/
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc"
}[5m])) by (destination_service_name) * 100

# gRPC errors broken down by status code
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc",
  grpc_response_status!="0"
}[5m])) by (destination_service_name, grpc_response_status)

# DEADLINE_EXCEEDED specifically (timeout issues)
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc",
  grpc_response_status="4"
}[5m])) by (source_workload, destination_workload)

# UNAVAILABLE errors (service overloaded or crashing)
sum(rate(istio_requests_total{
  reporter="destination",
  request_protocol="grpc",
  grpc_response_status="14"
}[5m])) by (destination_service_name)
```

**The HTTP 200 trap:** A common mistake is alerting only on HTTP 5xx errors for gRPC services. gRPC errors come back as HTTP 200 with a non-zero `grpc-status` trailer. If your monitoring only looks at `response_code`, you'll miss all gRPC errors. **Always use `grpc_response_status` for gRPC services.**

**What to alert on:**

```yaml
# Alert: gRPC error rate exceeds 5%
- alert: GRPCHighErrorRate
  expr: |
    (
      sum(rate(istio_requests_total{
        reporter="destination",
        request_protocol="grpc",
        grpc_response_status!="0",
        grpc_response_status!="1"
      }[5m])) by (destination_service_name)
      /
      sum(rate(istio_requests_total{
        reporter="destination",
        request_protocol="grpc"
      }[5m])) by (destination_service_name)
    ) > 0.05
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "gRPC error rate >5% on {{ $labels.destination_service_name }}"

# Alert: DEADLINE_EXCEEDED spike (timeout issues)
- alert: GRPCDeadlineExceeded
  expr: |
    sum(rate(istio_requests_total{
      reporter="destination",
      request_protocol="grpc",
      grpc_response_status="4"
    }[5m])) by (destination_service_name) > 1
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "gRPC DEADLINE_EXCEEDED errors on {{ $labels.destination_service_name }}"
```

Note: We exclude status code `1` (CANCELLED) from the error rate because client-initiated cancellations are normal behavior, not server errors.

---

### Golden Signal 4: Saturation

gRPC uses HTTP/2 multiplexing, so connection-level saturation looks different from HTTP/1.1.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `envoy_cluster_upstream_cx_active` | Gauge | Active HTTP/2 connections |
| `envoy_cluster_upstream_rq_active` | Gauge | Active requests (streams) across all connections |
| `envoy_cluster_upstream_cx_rx_bytes_total` | Counter | Bytes received |
| `envoy_cluster_upstream_cx_tx_bytes_total` | Counter | Bytes sent |
| `envoy_cluster_http2_pending_send_bytes` | Gauge | HTTP/2 data buffered waiting to send (flow control backpressure) |

**PromQL queries:**

```promql
# Active streams per connection (high = good multiplexing, but watch limits)
envoy_cluster_upstream_rq_active / envoy_cluster_upstream_cx_active

# HTTP/2 flow control backpressure (buffered data waiting to send)
envoy_cluster_http2_pending_send_bytes > 0

# Max concurrent streams approaching limit
# Default Envoy max concurrent streams per connection: 2147483647
# If your server sets a lower limit, watch this
envoy_cluster_upstream_rq_active
```

---

## Data Plane Summary Dashboard

Here's a consolidated view of the essential panels for a data plane Grafana dashboard:

| Panel | Query | Protocol |
|-------|-------|----------|
| Request Rate | `sum(rate(istio_requests_total{reporter="destination"}[5m])) by (destination_service_name)` | All |
| P99 Latency | `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket{reporter="destination"}[5m])) by (le, destination_service_name))` | All |
| Error Rate % | `sum(rate(istio_requests_total{response_code=~"5.*"}[5m])) / sum(rate(istio_requests_total[5m])) * 100` | HTTP |
| gRPC Error Rate % | `sum(rate(istio_requests_total{grpc_response_status!="0"}[5m])) / sum(rate(istio_requests_total{request_protocol="grpc"}[5m])) * 100` | gRPC |
| TLS Errors | `sum(rate(envoy_cluster_ssl_connection_error[5m])) by (pod)` | TLS |
| Circuit Breaker Trips | `sum(rate(envoy_cluster_upstream_cx_overflow[5m])) by (cluster_name)` | All |
| Envoy Memory | `envoy_server_memory_allocated` | All |
| Active Connections | `envoy_cluster_upstream_cx_active` | All |

---

## Common Pitfalls

### 1. Only Monitoring HTTP Status Codes for gRPC

gRPC errors return HTTP 200. If your dashboards only show `response_code=~"5.*"`, you're blind to gRPC failures. Always use `grpc_response_status` for gRPC services.

### 2. Ignoring the Source vs Destination Reporter

`reporter="source"` and `reporter="destination"` give different perspectives. Source includes network latency; destination doesn't. If you mix them in the same query, you'll get double-counted or misleading results.

### 3. Missing TLS Error Metrics

mTLS issues are the #1 source of mysterious 503 errors in Istio. Without TLS handshake error metrics, you'll spend hours debugging what looks like an application error but is actually a certificate problem.

### 4. Not Using Envoy Response Flags

`response_flags` tells you **why** Envoy returned an error, not just **what** the error code was. A 503 with `UH` (no healthy upstream) is a completely different problem from a 503 with `UC` (upstream connection termination). Always include response flags in your error dashboards.

### 5. Ignoring Saturation Until It's Too Late

Circuit breaker trips (`envoy_cluster_upstream_cx_overflow`) are the clearest early warning that a service is under stress. By the time you see elevated error rates, the circuit breaker has already been tripping for a while.

---

## What's Next

This covered the data plane — the Envoy sidecars processing your traffic. But a healthy data plane depends entirely on a healthy control plane.

**[Continue to Part 2: Golden Signals for the Control Plane (istiod)](/blog/istio-observability-control-plane/)** — where we cover xDS push latency, config convergence time, xDS rejections, certificate signing health, and istiod scaling thresholds.

---

*Related posts:*
- *[Part 2: Golden Signals for the Control Plane (istiod)](/blog/istio-observability-control-plane/)*
- *[Envoy Config Dump Explained](/blog/envoy-config-dump-explained/)*
- *[mTLS Debugging Guide](/blog/mtls-debugging-guide/)*
