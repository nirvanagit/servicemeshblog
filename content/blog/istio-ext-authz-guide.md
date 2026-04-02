---
title: "Building a Custom ext_authz Server for Istio: From Code to Production"
date: 2026-03-20
draft: false
tags: ["istio", "envoy", "security", "authorization", "golang"]
categories: ["security"]
author: "Service Mesh Blog"
description: "How Envoy's ext_authz protocol works, why it's the right approach for custom authorization in Istio, and a complete walkthrough of building and deploying a gRPC ext_authz server."
ShowToc: true
TocOpen: false
---

## The Problem: Custom Auth at the Gateway

You're running Istio. Traffic enters through the Ingress Gateway. You need to enforce authentication — maybe Basic Auth, maybe API keys, maybe a custom token scheme that your organization uses internally.

Istio gives you `RequestAuthentication` for JWT validation and `AuthorizationPolicy` for RBAC. But what if your auth logic doesn't fit neatly into JWT claims or RBAC rules? What if you need to:

- Validate credentials against an internal user database
- Check API keys against a rate-limiting backend
- Implement a custom token format that predates your service mesh
- Apply business-specific authorization rules that change frequently

This is where **ext_authz** comes in.

---

## What is ext_authz?

`ext_authz` is a built-in Envoy filter that delegates authorization decisions to an **external service**. Instead of encoding auth logic in Envoy's configuration, Envoy sends the request metadata to your service, your service says "allow" or "deny", and Envoy enforces the decision.

```mermaid
sequenceDiagram
    participant Client
    participant Gateway as Istio Gateway<br/>(Envoy)
    participant AuthZ as ext_authz<br/>Server
    participant Upstream as Backend<br/>Service

    Client->>Gateway: GET /api/data<br/>Authorization: Basic dXNlcjpwYXNz

    Gateway->>AuthZ: CheckRequest<br/>(method, path, headers)

    alt Credentials Valid
        AuthZ->>Gateway: OK (200)<br/>+ inject x-auth-user header
        Gateway->>Upstream: GET /api/data<br/>x-auth-user: admin
        Upstream->>Gateway: 200 OK
        Gateway->>Client: 200 OK
    else Credentials Invalid
        AuthZ->>Gateway: Denied (403)<br/>{"error": "Invalid credentials"}
        Gateway->>Client: 403 Forbidden<br/>{"error": "Invalid credentials"}
    end
```

The key insight: **Envoy never forwards the request to the upstream if ext_authz denies it.** The denied response goes directly back to the client from the gateway.

---

## ext_authz Protocol: gRPC vs HTTP

Envoy supports two modes for ext_authz:

### gRPC (Recommended)

Your auth server implements the `envoy.service.auth.v3.Authorization` gRPC service. Envoy sends a `CheckRequest` protobuf message, and your server returns a `CheckResponse`.

**Advantages:**
- Strongly typed — protobuf contract between Envoy and your server
- Full request metadata available (headers, path, method, source IP, SNI, etc.)
- Can inject/remove headers on both allow and deny responses
- Better performance — gRPC uses HTTP/2, persistent connections, binary encoding

### HTTP

Your auth server is a plain HTTP endpoint. Envoy forwards selected request headers to your server. If your server returns 200, the request is allowed. Any other status code means denied.

**Advantages:**
- Simpler to implement — any HTTP server works
- Easier to test with `curl`

**Disadvantages:**
- Less control over what request metadata you receive
- Can't inject headers into the upstream request as cleanly
- Text-based HTTP/1.1 overhead

For production Istio deployments, **always use gRPC**. The type safety and header injection capabilities are essential.

---

## The gRPC Protocol in Detail

The ext_authz gRPC interface is defined in Envoy's protobuf spec. Here's what matters:

### CheckRequest — What Envoy Sends

When a request arrives at the gateway, Envoy constructs a `CheckRequest` and sends it to your server:

```protobuf
message CheckRequest {
  // Source and destination info
  AttributeContext attributes = 1;
}

message AttributeContext {
  // The source (downstream client)
  Peer source = 1;
  // The destination (the Envoy proxy itself)
  Peer destination = 2;
  // The HTTP request details
  HttpRequest request = 4;
}

message HttpRequest {
  string id = 1;           // Unique request ID
  string method = 2;       // GET, POST, etc.
  map<string, string> headers = 3;  // All request headers
  string path = 4;         // /api/v1/data
  string host = 5;         // api.example.com
  string scheme = 6;       // https
  string protocol = 7;     // HTTP/1.1 or HTTP/2
  // Body is NOT sent by default (configurable)
}
```

Your auth server receives **everything it needs** to make an authorization decision: the full URL, all headers (including `Authorization`, cookies, API keys), the source IP, and the destination.

### CheckResponse — What Your Server Returns

Your server returns one of two responses:

**Allow:**

```protobuf
CheckResponse {
  status: OK
  ok_response: {
    // Headers to ADD to the request before forwarding upstream
    headers: [
      {key: "x-auth-user", value: "admin"},
      {key: "x-auth-roles", value: "editor,viewer"}
    ]
  }
}
```

**Deny:**

```protobuf
CheckResponse {
  status: PERMISSION_DENIED
  denied_response: {
    status: {code: 403}
    headers: [
      {key: "content-type", value: "application/json"}
    ]
    body: '{"error": "Invalid credentials"}'
  }
}
```

The deny response is powerful — you control the exact HTTP status code, headers, and body that the client receives. No generic "RBAC: access denied" messages.

---

## Building the ext_authz Server

Let's build a production-ready gRPC ext_authz server in Go that implements Basic Auth. The complete source is in the [`ext-authz-app/`](https://github.com/nirvanagit/servicemeshblog/tree/main/ext-authz-app) directory of this blog's repo.

### Project Structure

```
ext-authz-app/
├── main.go              # gRPC server + auth logic
├── go.mod
├── Dockerfile           # Multi-stage distroless build
└── k8s/
    ├── deployment.yaml  # Kubernetes deployment + service + secret
    └── istio.yaml       # AuthorizationPolicy + mesh config
```

### The Core: Implementing the Check RPC

The heart of the server is the `Check` method. Envoy calls this for every request:

```go
func (s *AuthServer) Check(
    _ context.Context,
    req *auth.CheckRequest,
) (*auth.CheckResponse, error) {

    httpReq := req.GetAttributes().GetRequest().GetHttp()
    path := httpReq.GetPath()
    headers := httpReq.GetHeaders()

    // 1. Skip auth for allowed paths (health checks, public assets)
    for _, allowed := range s.config.AllowedPaths {
        if strings.HasPrefix(path, allowed) {
            return allowResponse("allowed-path"), nil
        }
    }

    // 2. Extract and validate the Authorization header
    authHeader, exists := headers["authorization"]
    if !exists {
        return deniedResponse(401, "Authorization header required"), nil
    }

    // 3. Parse Basic auth credentials
    username, password, ok := parseBasicAuth(authHeader)
    if !ok {
        return deniedResponse(401, "Malformed Basic auth"), nil
    }

    // 4. Validate against configured users
    expectedPassword, userExists := s.config.Users[username]
    if !userExists || expectedPassword != password {
        return deniedResponse(403, "Invalid credentials"), nil
    }

    // 5. Allowed — inject identity headers upstream
    return &auth.CheckResponse{
        Status: &status.Status{Code: int32(codes.OK)},
        HttpResponse: &auth.CheckResponse_OkResponse{
            OkResponse: &auth.OkHttpResponse{
                Headers: []*core.HeaderValueOption{
                    {
                        Header: &core.HeaderValue{
                            Key:   "x-auth-user",
                            Value: username,
                        },
                    },
                },
            },
        },
    }, nil
}
```

**Key design decisions:**

1. **AllowedPaths bypass auth entirely** — health checks and public endpoints don't need credentials. This is checked first to minimize latency on health probes.
2. **Users are loaded from an environment variable** (`USERS_JSON`) — sourced from a Kubernetes Secret. No hardcoded credentials.
3. **On success, we inject `x-auth-user` upstream** — the backend service knows who the caller is without parsing the `Authorization` header itself.
4. **On failure, we return structured JSON** — not a plain text error.

### Building the Deny Response

When you deny a request, you control the full response the client sees:

```go
func deniedResponse(httpStatus int, message string) *auth.CheckResponse {
    return &auth.CheckResponse{
        Status: &status.Status{
            Code: int32(codes.PermissionDenied),
        },
        HttpResponse: &auth.CheckResponse_DeniedHttpResponse{
            DeniedHttpResponse: &auth.DeniedHttpResponse{
                Status: &envoy_type.HttpStatus{
                    Code: envoy_type.StatusCode(httpStatus),
                },
                Headers: []*core.HeaderValueOption{
                    {
                        Header: &core.HeaderValue{
                            Key:   "content-type",
                            Value: "application/json",
                        },
                    },
                },
                Body: fmt.Sprintf(`{"error": "%s"}`, message),
            },
        },
    }
}
```

This gives you a clean JSON error response:

```bash
$ curl -i https://api.example.com/api/data
HTTP/1.1 401 Unauthorized
content-type: application/json
x-auth-decision: denied

{"error": "Authorization header required"}
```

---

## Deploying to Kubernetes + Istio

### Step 1: Deploy the ext_authz Server

```bash
# Create the namespace and deploy
kubectl apply -f ext-authz-app/k8s/deployment.yaml

# Verify it's running
kubectl get pods -n auth
# NAME                         READY   STATUS    RESTARTS   AGE
# ext-authz-6d4f8b7c9-x2k4p   2/2     Running   0          30s
# ext-authz-6d4f8b7c9-m8n3q   2/2     Running   0          30s
```

The deployment includes:
- **2 replicas** for high availability
- **Resource limits** (200m CPU, 128Mi memory) — ext_authz servers are lightweight
- **Health probes** on the HTTP health endpoint (port 8080)
- **Credentials in a Kubernetes Secret** — not in the deployment spec

### Step 2: Register the Provider in Istio's Mesh Config

Istio needs to know about your ext_authz service. Edit the Istio ConfigMap:

```bash
kubectl edit configmap istio -n istio-system
```

Add your provider under `extensionProviders`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |-
    extensionProviders:
    - name: "ext-authz-grpc"
      envoyExtAuthzGrpc:
        service: "ext-authz.auth.svc.cluster.local"
        port: 9001
        timeout: 3s
        failOpen: false
```

**Configuration explained:**

| Field | Value | Why |
|-------|-------|-----|
| `service` | `ext-authz.auth.svc.cluster.local` | Full DNS name of the auth service |
| `port` | `9001` | gRPC port |
| `timeout` | `3s` | Max time to wait for auth decision — avoid blocking requests if auth is slow |
| `failOpen` | `false` | If the auth server is unreachable, **deny** the request. Set to `true` only if availability > security |

After editing, restart the Istio control plane to pick up the change:

```bash
kubectl rollout restart deployment istiod -n istio-system
```

### Step 3: Apply the AuthorizationPolicy

Now tell Istio **where** to enforce ext_authz:

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: ext-authz-gateway
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: CUSTOM
  provider:
    name: ext-authz-grpc
  rules:
  - to:
    - operation:
        paths: ["/*"]
        notPaths: ["/healthz", "/readyz"]
```

```bash
kubectl apply -f ext-authz-app/k8s/istio.yaml
```

**What this does:**
- Applies to the **Istio Ingress Gateway** (`istio: ingressgateway`)
- Uses the `CUSTOM` action, which delegates to the named provider
- Applies to all paths **except** health check endpoints
- The `notPaths` exclusion happens at the Envoy level — these requests never hit your auth server

### Step 4: Test It

```bash
GATEWAY_IP=$(kubectl -n istio-system get svc istio-ingressgateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# No credentials — should get 401
curl -i http://$GATEWAY_IP/api/data
# HTTP/1.1 401 Unauthorized
# {"error": "Authorization header required"}

# Wrong credentials — should get 403
curl -i -u wronguser:wrongpass http://$GATEWAY_IP/api/data
# HTTP/1.1 403 Forbidden
# {"error": "Invalid credentials"}

# Valid credentials — should get 200
curl -i -u admin:changeme http://$GATEWAY_IP/api/data
# HTTP/1.1 200 OK
# x-auth-user: admin
```

---

## How ext_authz Maps to Envoy Config

When you apply the `AuthorizationPolicy` with `action: CUSTOM`, Istio translates it into an Envoy `ext_authz` HTTP filter in the gateway's listener config. You can inspect it:

```bash
istioctl proxy-config listener deploy/istio-ingressgateway \
  -n istio-system -o json | jq '
    .[].filterChains[].filters[]
    | select(.name == "envoy.filters.network.http_connection_manager")
    | .typedConfig.httpFilters[]
    | select(.name == "envoy.filters.http.ext_authz")
  '
```

Output:

```json
{
  "name": "envoy.filters.http.ext_authz",
  "typedConfig": {
    "@type": "type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz",
    "grpcService": {
      "envoyGrpc": {
        "clusterName": "outbound|9001||ext-authz.auth.svc.cluster.local",
        "authority": "ext-authz.auth.svc.cluster.local"
      },
      "timeout": "3s"
    },
    "failureModeAllow": false,
    "transportApiVersion": "V3",
    "withRequestBody": {
      "maxRequestBytes": 0,
      "allowPartialMessage": true
    }
  }
}
```

The ext_authz filter is inserted **before** the router filter in the HTTP filter chain. This means auth is evaluated before any routing or upstream connection happens.

---

## Architecture: Where ext_authz Fits in the Request Path

```mermaid
graph LR
    subgraph Gateway["Istio Ingress Gateway (Envoy)"]
        direction LR
        L["Listener<br/>:443"] --> TLS["TLS<br/>Termination"]
        TLS --> HCM["HTTP Connection<br/>Manager"]
        HCM --> RBAC["RBAC<br/>Filter"]
        RBAC --> EXT["ext_authz<br/>Filter"]
        EXT --> ROUTER["Router<br/>Filter"]
    end

    Client(("Client")) --> L
    ROUTER --> Upstream["Backend<br/>Service"]
    EXT -.->|"gRPC Check"| AuthZ["ext_authz<br/>Server"]

    style EXT fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style AuthZ fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Gateway fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

**Filter execution order matters:**
1. **RBAC filter** — Istio's built-in `ALLOW`/`DENY` policies evaluate first
2. **ext_authz filter** — your custom auth runs next
3. **Router filter** — only reached if both RBAC and ext_authz allow the request

If you have both `DENY` policies (e.g., block certain IPs) and `CUSTOM` ext_authz, the `DENY` policies short-circuit first. This is efficient — you don't waste ext_authz calls on requests that would be blocked anyway.

---

## Performance Considerations

ext_authz adds a **network round-trip** to every request that triggers it. Here's how to minimize the impact:

### 1. Keep the Auth Server Close

Deploy ext_authz pods in the **same cluster and ideally the same node pool** as your gateway. Cross-zone latency adds up.

```yaml
# Prefer scheduling near the gateway
affinity:
  podAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchLabels:
            istio: ingressgateway
        topologyKey: kubernetes.io/hostname
```

### 2. Use notPaths for Static Assets

Don't run auth checks on static assets, health probes, or public endpoints:

```yaml
rules:
- to:
  - operation:
      paths: ["/api/*", "/admin/*"]
      # Static assets, health checks automatically excluded
```

### 3. Set Aggressive Timeouts

If the auth server is slow or down, don't let it block all traffic:

```yaml
envoyExtAuthzGrpc:
  timeout: 1s        # Fail fast
  failOpen: false     # But still deny on timeout (secure default)
```

### 4. Measure the Overhead

```bash
# Without ext_authz
kubectl exec deploy/sleep -- wrk -t2 -c10 -d30s http://gateway/api/test
# Requests/sec:  2847.32
# Avg Latency:   3.51ms

# With ext_authz
kubectl exec deploy/sleep -- wrk -t2 -c10 -d30s \
  -H "Authorization: Basic YWRtaW46Y2hhbmdlbWU=" \
  http://gateway/api/test
# Requests/sec:  2634.18
# Avg Latency:   3.79ms
```

Typical overhead: **0.2–0.5ms per request** for a well-deployed gRPC ext_authz server in the same cluster.

---

## ext_authz vs Other Istio Auth Approaches

| Approach | Best For | Limitation |
|----------|----------|-----------|
| **RequestAuthentication** (JWT) | Standard JWT/OIDC tokens | Only validates JWT — can't do custom token formats or database lookups |
| **AuthorizationPolicy** (RBAC) | Path/method/header-based rules | Static rules — can't call external systems for decisions |
| **EnvoyFilter** (inline basic auth) | Simplest possible basic auth | Credentials in Envoy config, no external validation, hard to update |
| **ext_authz (gRPC)** | Custom auth logic, external lookups, dynamic rules | Adds network latency, requires deploying/maintaining a service |
| **ext_authz (HTTP)** | Quick prototyping | Less control than gRPC, no typed contract |
| **WASM filter** | Auth logic that must run in-process | Sandbox limitations, debugging difficulty, memory overhead |
| **ext_proc** | Auth that needs request/response body inspection | Higher latency, more complex protocol |

**Rule of thumb:** Start with `RequestAuthentication` + `AuthorizationPolicy` if your tokens are JWTs. Use ext_authz when you outgrow those.

---

## Debugging ext_authz

### Check if the Filter is Applied

```bash
# Verify the ext_authz filter exists in the gateway config
istioctl proxy-config listener deploy/istio-ingressgateway \
  -n istio-system -o json | grep ext_authz
```

### Enable Debug Logging

```bash
# On the gateway
istioctl proxy-config log deploy/istio-ingressgateway \
  -n istio-system --level ext_authz:debug

# Watch the gateway logs
kubectl logs deploy/istio-ingressgateway -n istio-system -f | grep ext_authz
```

### Check the Auth Server Logs

```bash
kubectl logs deploy/ext-authz -n auth -f
# [ext-authz] GET /api/data
# [ext-authz] ALLOWED: user=admin on GET /api/data
```

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| All requests return 403 | Auth server unreachable + `failOpen: false` | Check service DNS, port, and mTLS settings |
| Auth server never receives requests | `extensionProvider` name mismatch | Verify the name in `AuthorizationPolicy.provider` matches `meshConfig.extensionProviders[].name` |
| Auth works but upstream gets no `x-auth-user` header | Header injection not configured | Ensure `ok_response.headers` is set in `CheckResponse` |
| Intermittent 503 errors | Auth server pod restarts under load | Increase resource limits, add replicas |
| Requests hang for 3 seconds then fail | Auth server is slow, hitting timeout | Profile the auth server, optimize DB lookups |

### The mTLS Gotcha

If the `auth` namespace has Istio sidecar injection enabled, traffic between the gateway and your ext_authz server flows through mTLS. This is good for security but can cause issues:

- The ext_authz server sees requests coming from `127.0.0.1` (the sidecar), not the original client IP
- If you disable sidecar injection on the auth namespace, you need a `PeerAuthentication` policy to allow plaintext

```yaml
# If ext_authz is NOT in the mesh, allow plaintext from the gateway
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: ext-authz-plaintext
  namespace: auth
spec:
  mtls:
    mode: PERMISSIVE
```

---

## Going Beyond Basic Auth

The ext_authz pattern is not limited to Basic Auth. The same gRPC interface supports:

- **API key validation** — read `x-api-key` header, validate against a database
- **OAuth2 token introspection** — call your OAuth provider's introspection endpoint
- **Custom HMAC signatures** — validate request signatures for webhook endpoints
- **Multi-tenant isolation** — check that the authenticated tenant can access the requested path
- **Feature flags** — allow/deny based on feature flag state from LaunchDarkly or similar
- **Request rate limiting** — combine auth with per-user rate limit checks in a single call

The ext_authz server is your code, your logic, your language. Envoy just delegates the decision.

---

## Conclusion

ext_authz is the escape hatch when Istio's built-in auth primitives aren't enough. The gRPC protocol gives you full access to request metadata, typed responses, and header injection. The operational cost is one additional service to deploy — but for teams that need custom auth logic, it's far simpler than maintaining WASM filters or forking Envoy.

Start with the [sample ext_authz server](https://github.com/nirvanagit/servicemeshblog/tree/main/ext-authz-app) in this blog's repo, swap the Basic Auth logic for your own, and deploy it alongside your Istio gateway.

---

*Related posts:*
- *[mTLS Debugging Guide](/blog/mtls-debugging-guide/)*
- *[How WebAssembly Actually Works Inside Envoy Proxy](/blog/how-wasm-works-in-envoy/)*
- *[Envoy Config Dump Explained](/blog/envoy-config-dump-explained/)*
