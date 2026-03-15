---
title: "Building Envoy WASM Filters: From Hello World to Production"
date: 2026-02-20
draft: false
tags: ["envoy", "wasm", "golang", "kubernetes", "istio"]
categories: ["traffic-management"]
author: "Service Mesh Blog"
description: "A practical guide to building, testing, and deploying WebAssembly extensions for Envoy Proxy — with real Go examples and production deployment patterns."
cover:
  image: ""
  alt: "Envoy WASM Filter Pipeline"
  caption: ""
  relative: false
ShowToc: true
TocOpen: false
---

## Why WASM for Envoy?

Envoy's native C++ extension points (HTTP filters, network filters, access loggers) are powerful but require recompiling Envoy itself. WebAssembly (WASM) changes this: compile your extension once, deploy it to any Envoy instance without rebuilding.

Use cases for WASM filters:
- Custom authentication (e.g., validating proprietary JWT claims)
- Request/response transformation (header manipulation, body rewriting)
- Custom rate limiting logic
- Request routing based on business rules
- Telemetry enrichment with business metadata

## The proxy-wasm ABI

WASM filters communicate with Envoy through the **proxy-wasm ABI** — a well-defined interface covering:
- HTTP lifecycle hooks (`onRequestHeaders`, `onRequestBody`, `onResponseHeaders`, etc.)
- Shared data stores (shared KV store accessible across filter instances)
- Timer callbacks
- gRPC calls to external services
- Metrics

The `proxy-wasm-go-sdk` is the easiest SDK to work with for Go developers.

## Building a Custom Header Filter in Go

### Prerequisites

```bash
# Install TinyGo (required for proxy-wasm Go compilation)
brew install tinygo

# Install wasme CLI (optional but useful)
brew install webassemblyhub/tap/wasme
```

### Project Structure

```
my-wasm-filter/
├── main.go
├── go.mod
└── Makefile
```

### Writing the Filter

```go
// main.go
package main

import (
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm"
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm/types"
)

func main() {
    proxywasm.SetVMContext(&vmContext{})
}

type vmContext struct{}

func (*vmContext) OnVMStart(vmConfigurationSize int) types.OnVMStartStatus {
    return types.OnVMStartStatusOK
}

func (*vmContext) NewPluginContext(contextID uint32) types.PluginContext {
    return &pluginContext{}
}

type pluginContext struct{}

func (*pluginContext) OnPluginStart(pluginConfigurationSize int) types.OnPluginStartStatus {
    return types.OnPluginStartStatusOK
}

func (*pluginContext) NewHttpContext(contextID uint32) types.HttpContext {
    return &httpContext{contextID: contextID}
}

type httpContext struct {
    types.DefaultHttpContext
    contextID uint32
}

// Called when request headers arrive
func (ctx *httpContext) OnHttpRequestHeaders(numHeaders int, endOfStream bool) types.Action {
    // Read an existing header
    userAgent, err := proxywasm.GetHttpRequestHeader("user-agent")
    if err != nil {
        proxywasm.LogWarnf("failed to get user-agent header: %v", err)
    }

    // Add a custom header
    if err := proxywasm.AddHttpRequestHeader("x-envoy-wasm-filter", "active"); err != nil {
        proxywasm.LogErrorf("failed to add header: %v", err)
        return types.ActionContinue
    }

    proxywasm.LogInfof("processed request from user-agent: %s", userAgent)
    return types.ActionContinue
}

// Called when response headers arrive
func (ctx *httpContext) OnHttpResponseHeaders(numHeaders int, endOfStream bool) types.Action {
    // Remove a response header for security
    if err := proxywasm.RemoveHttpResponseHeader("server"); err != nil {
        proxywasm.LogWarnf("failed to remove server header: %v", err)
    }

    // Add security headers
    headers := [][2]string{
        {"x-content-type-options", "nosniff"},
        {"x-frame-options", "DENY"},
        {"x-xss-protection", "1; mode=block"},
    }
    for _, h := range headers {
        _ = proxywasm.AddHttpResponseHeader(h[0], h[1])
    }

    return types.ActionContinue
}
```

### Building the WASM Binary

```makefile
# Makefile
.PHONY: build test

build:
    tinygo build -o filter.wasm -scheduler=none -target=wasi ./...

test:
    go test -v ./...
```

```bash
make build
# Output: filter.wasm (~200KB)
```

### Unit Testing WASM Filters

The proxy-wasm Go SDK includes a test harness that lets you unit test filters without Envoy:

```go
// main_test.go
package main

import (
    "testing"
    "github.com/stretchr/testify/require"
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm/proxytest"
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm/types"
)

func TestOnHttpRequestHeaders(t *testing.T) {
    opt := proxytest.NewEmulatorOption().WithVMContext(&vmContext{})
    host, reset := proxytest.NewHostEmulator(opt)
    defer reset()

    // Initialize plugin
    require.Equal(t, types.OnPluginStartStatusOK, host.StartPlugin())

    // Create HTTP context
    id := host.InitializeHttpContext()

    // Simulate request headers
    hs := [][2]string{
        {":authority", "example.com"},
        {":method", "GET"},
        {":path", "/api/v1/resource"},
        {"user-agent", "curl/7.68.0"},
    }
    action := host.CallOnRequestHeaders(id, hs, false)
    require.Equal(t, types.ActionContinue, action)

    // Verify our header was added
    resultHeaders := host.GetCurrentRequestHeaders(id)
    found := false
    for _, h := range resultHeaders {
        if h[0] == "x-envoy-wasm-filter" && h[1] == "active" {
            found = true
        }
    }
    require.True(t, found, "x-envoy-wasm-filter header should be present")
}
```

## Deploying to Istio

### Store the WASM in an OCI Registry

```bash
# Build and push to OCI registry (Docker Hub or GHCR)
docker build -t ghcr.io/yourorg/header-filter:v1.0.0 \
  --label "org.opencontainers.image.title=header-filter" .
docker push ghcr.io/yourorg/header-filter:v1.0.0
```

### Apply via WasmPlugin CRD

```yaml
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: security-headers
  namespace: production
spec:
  selector:
    matchLabels:
      app: frontend
  url: oci://ghcr.io/yourorg/header-filter:v1.0.0
  phase: AUTHN
  pluginConfig:
    strict_mode: true
```

```bash
kubectl apply -f wasmplugin.yaml

# Verify it loaded
kubectl get wasmplugin -n production
istioctl proxy-config log deploy/frontend --level wasm:debug
```

## Performance Considerations

WASM filters have overhead vs. native C++ filters:

| Aspect | Native C++ | WASM |
|--------|-----------|------|
| Latency overhead | ~0.1ms | ~0.5–2ms |
| Memory per instance | Shared | ~2–4MB WASM runtime |
| Compile time | Slow (rebuild Envoy) | Fast (tinygo ~5s) |
| Deploy without restart | No | Yes |

For latency-sensitive paths, keep WASM filters lightweight. Complex business logic is better off in an external `ext_authz` or `ext_proc` service.

## Common Pitfalls

1. **Blocking calls are not allowed** — WASM runs in Envoy's event loop. Never make synchronous HTTP calls. Use `DispatchHttpCall` for async external calls.
2. **Memory limits** — Default WASM module heap is 100MB. Set `vm_config.runtime: envoy.wasm.runtime.v8` and configure heap size if needed.
3. **No filesystem access** — WASM is sandboxed. Read config from plugin config JSON, not files.
4. **Shared state is per-worker** — Envoy runs multiple workers. Use the shared KV store API for cross-worker state.

## Conclusion

WASM filters hit a sweet spot between flexibility and performance. For teams using Istio, the `WasmPlugin` CRD makes deployment seamless. Start with the proxy-wasm-go-sdk, write unit tests with the emulator, and profile before deploying to latency-sensitive paths.

---

*Next: Using `ext_proc` for heavy-weight request processing that WASM can't handle.*
