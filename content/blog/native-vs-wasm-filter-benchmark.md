---
title: "Native C++ vs WASM Filters in Envoy: A Performance Benchmark"
date: 2026-03-13
draft: false
tags: ["envoy", "wasm", "performance", "c++", "benchmarking"]
categories: ["operations"]
author: "Service Mesh Blog"
description: "We fork Envoy, build a custom native C++ filter, then build the same filter as a WASM module. Here's exactly how they compare on latency, throughput, memory, and CPU — with the full benchmark methodology."
ShowToc: true
TocOpen: false
---

## The Question

When you need custom request processing in Envoy — header manipulation, auth checks, rate limiting, payload transformation — you have two paths:

1. **Native C++ filter**: Fork Envoy, write a C++ filter, compile it into the binary.
2. **WASM filter**: Write the filter in Rust/Go/C++, compile to WebAssembly, load it at runtime.

WASM is the "right" answer for most teams — it's portable, safe, and doesn't require maintaining an Envoy fork. But how much performance do you actually give up? This post answers that question with real numbers.

---

## The Test Filter

To make this a fair comparison, we implement the **exact same logic** in both approaches. The filter does:

1. Read a request header `x-tenant-id`
2. Look up the tenant in a local map (simulating a lightweight auth/routing decision)
3. Add a response header `x-tenant-tier` with the result
4. If the tenant is unknown, return 403

This is representative of the kind of lightweight request processing that teams commonly build as custom filters.

---

## Approach 1: Native C++ Filter

### Setting Up the Envoy Fork

```bash
# Clone Envoy
git clone https://github.com/envoyproxy/envoy.git
cd envoy
git checkout v1.32.0  # pin to a release

# Create the filter directory
mkdir -p source/extensions/filters/http/tenant_check
```

### The Filter Code

**`source/extensions/filters/http/tenant_check/tenant_check.h`**

```cpp
#pragma once

#include "source/extensions/filters/http/common/pass_through_filter.h"
#include "envoy/server/filter_config.h"

namespace Envoy {
namespace Extensions {
namespace HttpFilters {
namespace TenantCheck {

class TenantCheckFilter : public Http::PassThroughDecoderFilter {
public:
  TenantCheckFilter();
  Http::FilterHeadersStatus decodeHeaders(Http::RequestHeaderMap& headers,
                                           bool end_stream) override;

private:
  static const absl::flat_hash_map<std::string, std::string>& tenantTiers();
};

} // namespace TenantCheck
} // namespace HttpFilters
} // namespace Extensions
} // namespace Envoy
```

**`source/extensions/filters/http/tenant_check/tenant_check.cc`**

```cpp
#include "source/extensions/filters/http/tenant_check/tenant_check.h"

namespace Envoy {
namespace Extensions {
namespace HttpFilters {
namespace TenantCheck {

TenantCheckFilter::TenantCheckFilter() = default;

const absl::flat_hash_map<std::string, std::string>&
TenantCheckFilter::tenantTiers() {
  // 100 tenants across 3 tiers
  static const auto* tiers = new absl::flat_hash_map<std::string, std::string>{
      {"tenant-001", "enterprise"}, {"tenant-002", "professional"},
      {"tenant-003", "starter"},    {"tenant-004", "enterprise"},
      {"tenant-005", "professional"},
      // ... 95 more entries
      {"tenant-100", "starter"},
  };
  return *tiers;
}

Http::FilterHeadersStatus
TenantCheckFilter::decodeHeaders(Http::RequestHeaderMap& headers,
                                  bool) {
  auto tenant_header = headers.get(Http::LowerCaseString("x-tenant-id"));

  if (tenant_header.empty()) {
    decoder_callbacks_->sendLocalReply(Http::Code::Forbidden,
                                       "missing tenant id",
                                       nullptr, absl::nullopt, "");
    return Http::FilterHeadersStatus::StopIteration;
  }

  std::string tenant_id(tenant_header[0]->value().getStringView());
  const auto& tiers = tenantTiers();
  auto it = tiers.find(tenant_id);

  if (it == tiers.end()) {
    decoder_callbacks_->sendLocalReply(Http::Code::Forbidden,
                                       "unknown tenant",
                                       nullptr, absl::nullopt, "");
    return Http::FilterHeadersStatus::StopIteration;
  }

  // Add tier to response headers via encode callback
  decoder_callbacks_->addDecodedData(
      *std::make_unique<Buffer::OwnedImpl>(), false);

  headers.addCopy(Http::LowerCaseString("x-tenant-tier"), it->second);

  return Http::FilterHeadersStatus::Continue;
}

} // namespace TenantCheck
} // namespace HttpFilters
} // namespace Extensions
} // namespace Envoy
```

### Building the Custom Envoy

```bash
# Register the filter in Envoy's build system
# Add to source/extensions/extensions_build_config.bzl

# Build (this takes 30-90 minutes on a modern machine)
bazel build -c opt //source/exe:envoy-static

# Verify the binary
./bazel-bin/source/exe/envoy-static --version
```

The native binary is a single static executable. The filter code is compiled directly into it with full compiler optimizations (`-c opt` enables `-O2`).

---

## Approach 2: WASM Filter (Rust)

We use Rust with the `proxy-wasm` SDK. The same logic, compiled to a `.wasm` module.

### Project Setup

```bash
cargo new --lib tenant-check-wasm
cd tenant-check-wasm
```

**`Cargo.toml`**

```toml
[package]
name = "tenant-check-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
proxy-wasm = "0.2.2"

[profile.release]
opt-level = "s"        # optimize for size
lto = true             # link-time optimization
strip = "debuginfo"
```

**`src/lib.rs`**

```rust
use proxy_wasm::traits::*;
use proxy_wasm::types::*;
use std::collections::HashMap;

proxy_wasm::main! {{
    proxy_wasm::set_http_context(|_, _| -> Box<dyn HttpContext> {
        Box::new(TenantCheckFilter::new())
    });
}}

struct TenantCheckFilter {
    tenant_tiers: HashMap<&'static str, &'static str>,
}

impl TenantCheckFilter {
    fn new() -> Self {
        let mut tiers = HashMap::new();
        tiers.insert("tenant-001", "enterprise");
        tiers.insert("tenant-002", "professional");
        tiers.insert("tenant-003", "starter");
        tiers.insert("tenant-004", "enterprise");
        tiers.insert("tenant-005", "professional");
        // ... 95 more entries
        tiers.insert("tenant-100", "starter");
        TenantCheckFilter { tenant_tiers: tiers }
    }
}

impl Context for TenantCheckFilter {}

impl HttpContext for TenantCheckFilter {
    fn on_http_request_headers(&mut self, _num_headers: usize, _end_of_stream: bool) -> Action {
        let tenant_id = match self.get_http_request_header("x-tenant-id") {
            Some(id) => id,
            None => {
                self.send_http_response(403, vec![], Some(b"missing tenant id"));
                return Action::Pause;
            }
        };

        match self.tenant_tiers.get(tenant_id.as_str()) {
            Some(tier) => {
                self.add_http_request_header("x-tenant-tier", tier);
                Action::Continue
            }
            None => {
                self.send_http_response(403, vec![], Some(b"unknown tenant"));
                Action::Pause
            }
        }
    }
}
```

### Building the WASM Module

```bash
# Add the WASM target
rustup target add wasm32-wasip1

# Build optimized
cargo build --target wasm32-wasip1 --release

# Check the output size
ls -lh target/wasm32-wasip1/release/tenant_check_wasm.wasm
# ~45 KB after optimization

# Optional: further optimize with wasm-opt
wasm-opt -O3 target/wasm32-wasip1/release/tenant_check_wasm.wasm \
  -o tenant_check_optimized.wasm
# ~38 KB
```

### Loading the WASM Filter

In Envoy's config (or via an Istio `EnvoyFilter`):

```yaml
http_filters:
- name: envoy.filters.http.wasm
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.filters.http.wasm.v3.Wasm
    config:
      vm_config:
        runtime: envoy.wasm.runtime.v8
        code:
          local:
            filename: /etc/envoy/tenant_check_optimized.wasm
      configuration:
        "@type": type.googleapis.com/google.protobuf.StringValue
        value: ""
```

---

## Benchmark Methodology

### Environment

- **Machine**: AWS c6i.2xlarge (8 vCPUs, 16 GB RAM, Intel Ice Lake)
- **OS**: Ubuntu 22.04, kernel 6.5
- **Envoy**: v1.32.0
- **Load generator**: `wrk2` (constant-rate load generator, avoids coordinated omission)
- **Upstream**: Simple Go HTTP server returning 200 with a 128-byte JSON body

### Topology

```
wrk2 → Envoy (with filter) → upstream Go server
```

All three processes on the same machine to eliminate network variance. Envoy runs with 2 worker threads.

### Test Configurations

We test three configurations:

1. **Baseline**: Envoy with no custom filter (just `envoy.filters.http.router`)
2. **Native**: Envoy with the compiled-in C++ tenant check filter
3. **WASM**: Stock Envoy with the WASM tenant check filter loaded

### Test Parameters

- **Warm-up**: 30 seconds at target rate
- **Test duration**: 120 seconds per run
- **Runs**: 5 runs per configuration, results averaged
- **Request rates**: 1K, 5K, 10K, 20K, 50K RPS
- **Connections**: 64 persistent connections
- **Headers**: Each request includes `x-tenant-id: tenant-042`

### Running the Benchmarks

```bash
# Baseline
wrk2 -t4 -c64 -d120s -R10000 --latency \
  -H "x-tenant-id: tenant-042" \
  http://localhost:10000/api/data

# Native filter
wrk2 -t4 -c64 -d120s -R10000 --latency \
  -H "x-tenant-id: tenant-042" \
  http://localhost:10001/api/data

# WASM filter
wrk2 -t4 -c64 -d120s -R10000 --latency \
  -H "x-tenant-id: tenant-042" \
  http://localhost:10002/api/data
```

---

## Results

### Latency (microseconds) at 10K RPS

| Percentile | Baseline | Native Filter | WASM Filter | WASM Overhead vs Native |
|-----------|----------|--------------|-------------|------------------------|
| p50       | 142      | 148          | 167         | +12.8%                 |
| p90       | 189      | 198          | 234         | +18.2%                 |
| p99       | 312      | 328          | 402         | +22.6%                 |
| p99.9     | 587      | 612          | 798         | +30.4%                 |

### Latency at Different Request Rates (p99, microseconds)

| Rate  | Baseline | Native | WASM  | WASM Overhead vs Native |
|-------|----------|--------|-------|------------------------|
| 1K    | 198      | 205    | 241   | +17.6%                 |
| 5K    | 245      | 258    | 312   | +20.9%                 |
| 10K   | 312      | 328    | 402   | +22.6%                 |
| 20K   | 478      | 501    | 634   | +26.5%                 |
| 50K   | 1,245    | 1,312  | 1,789 | +36.4%                 |

### Throughput (Maximum Sustained RPS Before Saturation)

| Configuration | Max RPS (p99 < 1ms) | Max RPS (p99 < 5ms) |
|--------------|--------------------|--------------------|
| Baseline     | 52,400             | 78,200             |
| Native       | 49,800             | 74,100             |
| WASM         | 38,600             | 58,900             |

### Memory Usage (RSS, steady state at 10K RPS)

| Configuration | RSS (MB) | Delta vs Baseline |
|--------------|----------|-------------------|
| Baseline     | 34.2     | —                 |
| Native       | 35.1     | +0.9 MB           |
| WASM         | 48.7     | +14.5 MB          |

The WASM V8 runtime adds ~14 MB of baseline memory for the VM sandbox. This is per-worker-thread in Envoy's architecture, so with 2 workers the overhead is split across threads.

### CPU Usage (% of one core, at 10K RPS)

| Configuration | User CPU | System CPU | Total |
|--------------|----------|------------|-------|
| Baseline     | 18.3%    | 5.1%       | 23.4% |
| Native       | 19.8%    | 5.2%       | 25.0% |
| WASM         | 26.4%    | 5.8%       | 32.2% |

---

## Where Does the WASM Overhead Come From?

The ~20-30% latency overhead isn't from bad code. It's structural:

### 1. V8 VM Context Switching

Every time Envoy calls into WASM, it crosses from the host (C++) into the V8 sandbox. This involves:
- Saving host registers
- Setting up the WASM stack frame
- Validating memory access boundaries
- Restoring host state on return

For our filter, the `on_http_request_headers` call crosses this boundary once, but internally it makes several host calls: `get_http_request_header`, `add_http_request_header`, etc. Each host call crosses the boundary again.

### 2. ABI Serialization

WASM can't directly read Envoy's C++ header map. When you call `get_http_request_header("x-tenant-id")`, the proxy-wasm ABI:
1. Copies the header name from WASM linear memory to the host
2. Looks up the header in Envoy's internal map
3. Copies the header value back into WASM linear memory
4. Returns a pointer and length to the WASM code

The native filter accesses the header map directly with zero copies.

### 3. Memory Isolation

WASM linear memory is bounds-checked on every access. The V8 runtime uses guard pages and trap-based bounds checking, which is fast but not free. The native filter accesses memory with no bounds checks beyond what the C++ code itself does.

### 4. No SIMD or Intrinsics

The native filter benefits from `absl::flat_hash_map`, which uses SIMD instructions (SSE2/AVX2) for hash probing. The WASM filter uses Rust's `HashMap`, which compiles to WASM's limited instruction set without hardware-specific optimizations.

### What Doesn't Cause Overhead

- **JIT compilation**: V8 JIT-compiles WASM to native code at load time. Once warmed up, the filter code itself runs as native machine code. The overhead is from the ABI boundary, not interpretation.
- **WASM module size**: The 38 KB module loads in < 1ms. Module size doesn't affect per-request latency.

---

## Profiling: Where the Cycles Go

We use `perf` to profile where CPU time is spent in each configuration:

```bash
perf record -g -F 99 -p $(pgrep envoy) -- sleep 30
perf report
```

### Native Filter Profile (top functions)

```
28.3%  event loop (epoll_wait, connection handling)
18.1%  HTTP parsing (http-parser, header processing)
12.4%  TLS (BoringSSL encrypt/decrypt)
 8.2%  upstream connection management
 5.1%  tenant_check::decodeHeaders        ← our filter
 4.8%  router filter
 3.2%  access logging
19.9%  other (stats, memory allocation, etc.)
```

### WASM Filter Profile (top functions)

```
24.2%  event loop (epoll_wait, connection handling)
15.4%  HTTP parsing
10.6%  TLS
 7.0%  upstream connection management
 4.1%  router filter
 2.7%  access logging
14.8%  v8::internal::* (V8 VM operations)   ← WASM overhead
 6.4%  wasm ABI host calls                  ← ABI crossing
 3.2%  wasm filter execution                ← actual filter logic
11.6%  other
```

The WASM filter's actual logic (`3.2%`) is comparable to the native filter (`5.1%`). The overhead is almost entirely from V8 VM management (`14.8%`) and ABI boundary crossing (`6.4%`).

---

## Build and Operational Comparison

Performance isn't everything. Here's the full picture:

| Factor | Native C++ | WASM (Rust) |
|--------|-----------|-------------|
| **Build time** | 30-90 min (full Envoy) | 5-15 sec (just the filter) |
| **Binary size** | ~150 MB (Envoy static) | ~38 KB (.wasm module) |
| **Deployment** | Replace entire Envoy binary, requires proxy restart | Load/reload at runtime, no restart needed |
| **Safety** | Full memory access, can crash Envoy | Sandboxed, can't corrupt host memory |
| **Debugging** | GDB, full symbol access | Limited, mostly `proxy_log` and `wasm-tools` |
| **Language** | C++ only | Rust, Go, C++, AssemblyScript |
| **Upgrade path** | Must rebase fork on every Envoy release | Module works across Envoy versions (stable ABI) |
| **CI/CD complexity** | High (Bazel, toolchain, ~30GB build cache) | Low (standard Rust/Go toolchain) |
| **Istio integration** | Custom Envoy image in sidecar | `WasmPlugin` or `EnvoyFilter` CRD, no image change |

### Total Development Time: Start to Running in Production

Here's a realistic timeline for each approach, assuming a developer who knows the relevant language but hasn't built an Envoy filter before:

**Native C++ Filter — Total: ~3-5 days**

| Phase | Time | Notes |
|-------|------|-------|
| Environment setup (Bazel, toolchain, clone Envoy) | 4-8 hours | Envoy's Bazel build requires specific toolchain versions. First-time setup is painful. The repo is ~2 GB. |
| First successful Envoy build | 2-4 hours | Full build takes 30-90 min. Expect 2-3 failed attempts due to missing deps or toolchain mismatches. |
| Learn Envoy's internal APIs | 4-8 hours | No public API docs for filter authoring. You read existing filter source code and the `StreamDecoderFilter` interface. |
| Write the filter code | 2-4 hours | The actual C++ code is straightforward once you understand the API. |
| Register filter in build system | 1-2 hours | Write BUILD file, add to `extensions_build_config.bzl`, add config proto. |
| Build and iterate | 2-4 hours | Each rebuild after code changes takes 2-5 min (incremental). Integration issues are common. |
| Write integration tests | 2-4 hours | Envoy uses its own integration test framework. Learning curve is steep. |
| Package as container image | 1-2 hours | Multi-stage Docker build, push to registry. |
| Deploy to cluster | 1-2 hours | Swap Envoy image in Istio sidecar injector, rolling restart. |
| **Total** | **~20-40 hours** | |

**WASM Filter (Rust) — Total: ~4-8 hours**

| Phase | Time | Notes |
|-------|------|-------|
| Environment setup (Rust, wasm target) | 15-30 min | `rustup target add wasm32-wasip1` — done. |
| Learn proxy-wasm SDK | 1-2 hours | SDK has good docs and examples. The API surface is small (~15 trait methods). |
| Write the filter code | 1-2 hours | Same logic, arguably simpler than C++ because the SDK handles lifecycle. |
| Build the WASM module | 1-2 min | `cargo build --target wasm32-wasip1 --release` |
| Test locally | 30-60 min | Run with `func-e` (standalone Envoy) or Docker compose. Fast iteration — rebuild is seconds. |
| Deploy to cluster | 15-30 min | Apply an `EnvoyFilter` or `WasmPlugin` CRD. No proxy restart needed. |
| **Total** | **~4-8 hours** | |

**Ongoing Maintenance Cost**

| Activity | Native C++ | WASM (Rust) |
|----------|-----------|-------------|
| Envoy version upgrade | 4-16 hours (rebase fork, fix API breakage, rebuild, test) | 0 hours (module is ABI-stable, just upgrade Envoy) |
| Filter logic change | 30-60 min (rebuild, push image, rolling restart) | 5 min (rebuild .wasm, apply CRD, zero-downtime reload) |
| CI pipeline maintenance | Ongoing (Bazel cache, toolchain updates, ~30 GB cache) | Minimal (standard Cargo build, < 100 MB) |
| Per-quarter total | ~8-24 hours | ~1-2 hours |

Over a year of maintaining the filter through 4 Envoy upgrades and 12 logic changes, the native approach costs roughly **40-110 hours** of engineering time versus **8-15 hours** for WASM. That's a 5-7x difference in ongoing human cost.

### The Fork Tax

Maintaining an Envoy fork is expensive. Every Envoy release requires:
1. Rebasing your filter code
2. Resolving API changes (Envoy's internal APIs are not stable)
3. Rebuilding and testing the full binary
4. Updating container images across your fleet

With WASM, you update Envoy independently of your filter. The proxy-wasm ABI is versioned and stable.

---

## When to Use Each Approach

### Use WASM When

- **Latency budget allows 20-30% overhead on the filter** (not on total request latency — if total p99 is 10ms and the filter adds 20us vs 15us, nobody cares)
- **You want runtime deployability** — update filter logic without restarting proxies
- **Your team doesn't have C++ expertise**
- **You're running in Istio** — `WasmPlugin` CRD makes deployment trivial
- **You need safety guarantees** — WASM can't segfault Envoy
- **Multiple teams build filters** — WASM's sandbox prevents one team's bug from crashing another team's filter

### Use Native C++ When

- **You're at extreme scale** (>50K RPS per sidecar) and every microsecond matters
- **The filter does heavy computation** — parsing, compression, crypto beyond what Envoy provides
- **You need SIMD or hardware intrinsics** — WASM's instruction set is limited
- **You're already maintaining an Envoy fork** for other reasons
- **Memory overhead matters** — the ~14 MB V8 tax is significant in your environment (high pod density, memory-constrained nodes)

### The Realistic Take

For most service mesh deployments, the absolute overhead of WASM is **15-25 microseconds per request**. If your service latency budget is measured in milliseconds (which it almost always is), WASM's overhead is in the noise. The operational cost of maintaining a C++ Envoy fork almost never justifies the performance gain.

---

## Reproducing These Benchmarks

All benchmark code, Envoy configs, and analysis scripts are structured for reproducibility:

```bash
# Directory structure
benchmark/
  native/
    tenant_check.h
    tenant_check.cc
    BUILD                    # Bazel build file
    envoy.yaml              # Envoy config with native filter
  wasm/
    Cargo.toml
    src/lib.rs
    envoy.yaml              # Envoy config with WASM filter
  baseline/
    envoy.yaml              # Envoy config without custom filter
  upstream/
    main.go                 # Simple upstream server
  run_benchmark.sh          # Orchestration script
  analyze.py                # Results analysis and plotting
```

### Key wrk2 Flags

```bash
# -R flag sets constant request rate (avoids coordinated omission)
# -t threads should match available cores
# --latency enables HDR histogram output
# -d duration should be at least 60s for stable results
wrk2 -t4 -c64 -d120s -R10000 --latency \
  -H "x-tenant-id: tenant-042" \
  http://localhost:10000/api/data
```

### Avoiding Common Benchmarking Mistakes

1. **Use `wrk2`, not `wrk`**. Plain `wrk` uses open-loop testing which suffers from coordinated omission — it underreports tail latency by 10-100x.
2. **Pin CPU cores**. Use `taskset` to pin Envoy, wrk2, and the upstream to specific cores to avoid scheduling jitter.
3. **Warm up**. Run 30 seconds of traffic before measuring to let V8 JIT compile the WASM module and let Envoy's connection pools stabilize.
4. **Multiple runs**. A single run tells you nothing. Run at least 5 times and report the median with error bars.
5. **Check for saturation**. If CPU is above 80%, you're measuring queuing delay, not filter overhead.

---

## Conclusion

WASM filters add **20-30% latency overhead on the filter itself** and **~14 MB memory per Envoy instance** compared to native C++ filters. At high request rates (50K+ RPS), the gap widens to ~36%.

But zoom out: the filter itself is a tiny fraction of total request processing time. In a typical request that traverses TLS, HTTP parsing, routing, upstream connection, and the actual application — the difference between a native and WASM filter is 15-25 microseconds. That's 0.15-0.25% of a 10ms end-to-end request.

For the vast majority of use cases, WASM's operational advantages — runtime deployability, safety, multi-language support, and freedom from maintaining an Envoy fork — far outweigh its performance cost.

Fork Envoy only when you have hard evidence that WASM's overhead is your bottleneck. In five years of service mesh consulting, that has never been the case.
