---
title: "Istio Tamper Detection Enforcement: Feature Mapping for Each Attack Scenario"
date: 2026-04-11
draft: false
tags: ["tamper-detection", "security", "istio", "gateway", "authorization", "jwt", "ext-authz"]
categories: ["security"]
author: "Service Mesh Blog"
description: "Detailed mapping of Istio features to tamper detection scenarios. Learn which Istio capability enforces protection against each type of attack."
ShowToc: true
TocOpen: false
---

## Overview: Istio Tamper Detection Feature Map

This guide maps each attack scenario to the specific Istio features and components that enforce tamper detection:

```
Attack Type                 → Istio Feature              → Enforcement Mechanism
─────────────────────────────────────────────────────────────────────────────
Header Injection           → AuthorizationPolicy        → Custom header validation
JWT Token Modification    → RequestAuthentication       → Signature verification + claims validation
Request Body Tampering    → Custom ext_authz          → HMAC-SHA256 validation
Replay Attacks            → Custom ext_authz          → Nonce/timestamp tracking
```

---

## Scenario 1: Header Injection Attack

**Attack Description:** Attacker injects custom headers to escalate privileges or bypass validation.

```
Original Request:
POST /api/users HTTP/1.1
Authorization: Bearer eyJhbGc...
User-Agent: legitimate-app/1.0

Attacker's Modified Request:
POST /api/users HTTP/1.1
Authorization: Bearer eyJhbGc...
X-Admin: true               ← Injected!
X-Bypass-Auth: true         ← Injected!
User-Agent: legitimate-app/1.0
```

### Istio Feature: AuthorizationPolicy

**Component:** Security (AuthorizationPolicy CRD)

**Configuration:**

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: header-validation-policy
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: DENY  # Start with deny-all
  rules:
  # Block requests with custom headers not in allowlist
  - to:
    - operation:
        paths: ["/api/users"]
    when:
    - key: request.headers[x-admin]
      notValues: [""]  # If header exists and not empty → DENY
  - to:
    - operation:
        paths: ["/api/users"]
    when:
    - key: request.headers[x-bypass-auth]
      notValues: [""]  # If header exists → DENY
---
# Then allow legitimate traffic
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: header-allowlist-policy
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/users"]
    # Only these headers are allowed
    when:
    - key: request.headers[content-type]
      values: ["application/json"]
    - key: request.headers[authorization]
      values: ["Bearer *"]
    # All other headers are implicitly denied
```

### How AuthorizationPolicy Enforces This:

```
Request arrives at gateway:
   ├─ Request context extracted
   │  ├─ Headers: {authorization, x-admin, x-bypass-auth, ...}
   │  ├─ Request principal from JWT
   │  └─ Path: /api/users
   │
   ├─ AuthorizationPolicy evaluation (DENY rules first)
   │  ├─ Check: x-admin header exists?
   │  │  └─ YES → DENY (rule matched, implicit rejection)
   │  │
   │  └─ Request blocked before ALLOW rules checked
   │
   └─ Response: 403 Forbidden
      └─ Error: "Denied by authorization policy"
```

### Real Code Example:

```yaml
# Deny any request with suspicious headers
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: block-malicious-headers
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: DENY
  rules:
  # Block if X-Admin header is present
  - when:
    - key: request.headers[x-admin]
      values: ["*"]  # Any value
  # Block if X-Impersonate header is present
  - when:
    - key: request.headers[x-impersonate]
      values: ["*"]
  # Block if X-Bypass headers present
  - when:
    - key: request.headers[x-bypass-auth]
      values: ["*"]
  # Block if X-Privilege header present
  - when:
    - key: request.headers[x-privilege]
      values: ["*"]
```

**Why This Works:**

1. AuthorizationPolicy runs on every request to the gateway
2. Runs in Envoy (sidecar proxy), not in application
3. Can inspect any HTTP header before it reaches services
4. Multiple policies can stack (DENY rules + ALLOW rules)
5. Logging shows exactly which policy rejected the request

---

## Scenario 2: JWT Token Modification

**Attack Description:** Attacker modifies JWT token claims (e.g., role, org) and reuses the token.

```
Original JWT:
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.
eyJ1c2VyIjoiYWxpY2UiLCJyb2xlIjoidmlld2VyIiwib3JnIjoiYWNtZS1jb3JwIn0.
signature_abc123

Attacker modifies payload to:
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.
eyJ1c2VyIjoiYWxpY2UiLCJyb2xlIjoiYWRtaW4iLCJvcmciOiJldmlsLWNvcnAifQ.
signature_abc123  ← Still using old signature!
```

### Istio Feature: RequestAuthentication + AuthorizationPolicy

**Component 1: RequestAuthentication (Signature Verification)**

```yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-signature-validation
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:
    - "api.example.com"
    # forwardOriginalToken: true allows passing token downstream
    forwardOriginalToken: true
```

**How RequestAuthentication Enforces Signature Verification:**

```
1. Request arrives with JWT header:
   Authorization: Bearer eyJhbGc...signature_abc123

2. RequestAuthentication extracts JWT

3. Fetches JWKS from issuer:
   GET https://auth.example.com/.well-known/jwks.json
   └─ Response: [public_key_1, public_key_2, ...]

4. Signature verification:
   received_signature = "signature_abc123"
   
   computed_signature = HMAC-SHA256(
     public_key,
     "eyJhbGc...eyJ1c2VyIjoiYWxpY2UiLCJyb2xlIjoiYWRtaW4i"  ← Modified payload
   )
   = "computed_xyz789"
   
   Compare: "signature_abc123" ≠ "computed_xyz789"
   
5. Result: SIGNATURE INVALID
   └─ Inject claim: request.auth.authenticated = false

6. AuthorizationPolicy checks authenticated status
   └─ DENY if not authenticated
```

**Component 2: AuthorizationPolicy (Claims Validation)**

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: jwt-claims-validation
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: ALLOW
  rules:
  # Only allow authenticated requests (signature valid)
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/users/*"]
    to:
    - operation:
        paths: ["/api/v1/*"]
    when:
    # Additional claim validation
    - key: request.auth.claims[role]
      values: ["viewer", "editor"]  # Only these roles
    - key: request.auth.claims[org]
      values: ["acme-corp"]  # Only this org
    - key: request.auth.claims[exp]
      values: ["*"]  # Must have expiry claim
```

**Why This Double-Layer Works:**

```
Attack Path Analysis:

Stage 1 - RequestAuthentication (Signature Check):
  ✗ Token signature doesn't match modified payload
  └─ STOP: Token rejected before claims are even extracted
  
Stage 2 - AuthorizationPolicy (Claims Validation):
  If somehow signature passed (it won't):
  ✗ role = "admin" not in [viewer, editor]
  └─ DENY by claims validation
  
Result: Attack blocked at TWO layers
```

### Real Code Example:

```bash
# Test signature validation

# 1. Get valid token
VALID_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiYWxpY2UiLCJyb2xlIjoidmlld2VyIn0.signature123"

# 2. Modify payload (role: viewer → admin)
MODIFIED_PAYLOAD="eyJ1c2VyIjoiYWxpY2UiLCJyb2xlIjoiYWRtaW4ifQ"
MODIFIED_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${MODIFIED_PAYLOAD}.signature123"

# 3. Test with valid token
curl -X GET https://api.example.com/api/v1/data \
  -H "Authorization: Bearer $VALID_TOKEN"
# Result: 200 OK ✓

# 4. Test with modified token
curl -X GET https://api.example.com/api/v1/data \
  -H "Authorization: Bearer $MODIFIED_TOKEN"
# Result: 403 Forbidden
# Reason: JWT signature validation failed
```

---

## Scenario 3: Request Body Tampering

**Attack Description:** Attacker modifies request body (e.g., amount field) after legitimate signature.

```
Original Request:
POST /api/payment HTTP/1.1
X-Request-Signature: hmac_sha256_abc123
Content-Type: application/json

{
  "amount": 100,
  "recipient": "store-xyz"
}

Attacker modifies amount:
POST /api/payment HTTP/1.1
X-Request-Signature: hmac_sha256_abc123  ← Old signature!
Content-Type: application/json

{
  "amount": 10000,  ← Tampered!
  "recipient": "store-xyz"
}
```

### Istio Feature: Custom ext_authz Server

**Component:** Mesh Configuration + Custom ext_authz Provider

**Mesh Config:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |
    extensionProviders:
    - name: payment-authz
      envoyExtAuthzGrpc:
        service: payment-authz.default.svc.cluster.local
        port: 9000
        timeout: 2s
        headersToDownstreamOnAllow:
        - x-payment-verified
        headersToDownstreamOnDeny:
        - x-tampering-detected
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: body-tampering-check
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: CUSTOM
  provider:
    name: payment-authz
  rules:
  - to:
    - operation:
        methods: ["POST"]
        paths: ["/api/payment"]
```

**Custom ext_authz Server Implementation:**

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
    typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
)

func Authorize(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
    
    // Extract request body
    body := req.Attributes.Request.Http.Body
    
    // Extract X-Request-Signature header
    headers := req.Attributes.Request.Http.Headers
    clientSignature := headers["x-request-signature"]
    
    // Get secret key (from mounted secret)
    secretKey := os.Getenv("PAYMENT_SECRET_KEY")
    
    // Stage 1: Verify HMAC signature
    // ================================
    
    // Compute expected signature
    expectedSignature := ComputeHMAC(secretKey, body)
    
    if clientSignature != expectedSignature {
        // Body has been tampered with!
        return &authv3.CheckResponse{
            Status: status.New(codes.PermissionDenied, "body tampering detected").Proto(),
            Headers: &authv3.HeaderMutation{
                SetHeaders: map[string]*typev3.HeaderValue{
                    "x-tampering-detected": {RawValue: []byte("true")},
                    "x-reason": {RawValue: []byte("hmac-mismatch")},
                },
            },
        }, nil
    }
    
    // Stage 2: Verify Content-Length matches actual body
    // ===================================================
    
    contentLength := headers["content-length"]
    expectedLength := len(body)
    
    if contentLength != strconv.Itoa(expectedLength) {
        return Deny("content-length mismatch: header=%s, actual=%d",
                   contentLength, expectedLength)
    }
    
    // Stage 3: Validate amount field (optional application-level check)
    // ================================================================
    
    var payment struct {
        Amount    float64 `json:"amount"`
        Recipient string  `json:"recipient"`
    }
    
    if err := json.Unmarshal([]byte(body), &payment); err != nil {
        return Deny("invalid JSON: %v", err)
    }
    
    if payment.Amount <= 0 || payment.Amount > 100000 {
        return Deny("suspicious amount: %f", payment.Amount)
    }
    
    // All checks passed
    return &authv3.CheckResponse{
        Status: status.OK(ctx).Proto(),
        Headers: &authv3.HeaderMutation{
            SetHeaders: map[string]*typev3.HeaderValue{
                "x-payment-verified": {RawValue: []byte("true")},
            },
        },
    }, nil
}

func ComputeHMAC(secretKey, body string) string {
    h := hmac.New(sha256.New, []byte(secretKey))
    h.Write([]byte(body))
    return hex.EncodeToString(h.Sum(nil))
}
```

**How ext_authz Enforces Body Tampering Detection:**

```
1. Request arrives with body and X-Request-Signature header:
   POST /api/payment
   Body: {"amount": 10000, ...}
   X-Request-Signature: hmac_sha256_abc123

2. Envoy sends CheckRequest to ext_authz server:
   {
     attributes: {
       request: {
         http: {
           body: "{"amount": 10000, ...}",
           headers: {"x-request-signature": "hmac_sha256_abc123", ...}
         }
       }
     }
   }

3. ext_authz server verification:
   
   Step 1: HMAC Check
   ─────────────────
   received_signature = "hmac_sha256_abc123"
   computed_signature = HMAC-SHA256(secret_key, body)
   
   If original amount was 100:
     original_body = '{"amount": 100, ...}'
     original_signature = HMAC-SHA256(key, original) = "abc123"
   
   If attacker changes to 10000:
     modified_body = '{"amount": 10000, ...}'
     modified_signature = HMAC-SHA256(key, modified) = "xyz789"
   
   Compare: "abc123" ≠ "xyz789"
   Result: TAMPERING DETECTED!
   
   Step 2: Content-Length Check
   ────────────────────────────
   header content-length = "28"
   actual body length = "29"  (extra digit in 10000)
   
   Result: MISMATCH DETECTED!

4. ext_authz returns CheckResponse:
   status: PERMISSION_DENIED
   headers: {
     "x-tampering-detected": "true",
     "x-reason": "hmac-mismatch"
   }

5. Envoy rejects request:
   Response: 403 Forbidden
   Reason: ext_authz denied the request
```

---

## Scenario 4: Replay Attacks

**Attack Description:** Attacker captures a valid request and replays it multiple times.

```
Time T1: Valid request
POST /api/transfer HTTP/1.1
Authorization: Bearer eyJhbGc...
X-Nonce: nonce_abc123
X-Timestamp: 1712859600

{
  "amount": 50,
  "recipient": "store-xyz"
}
Result: 200 OK, Money transferred ✓

Time T2: Attacker replays same request
POST /api/transfer HTTP/1.1
Authorization: Bearer eyJhbGc...  ← Same token
X-Nonce: nonce_abc123              ← Same nonce
X-Timestamp: 1712859600            ← Same timestamp

{
  "amount": 50,
  "recipient": "store-xyz"
}
Result: 200 OK, Money transferred AGAIN ✗ (Should be denied!)
```

### Istio Feature: Custom ext_authz Server with Nonce Tracking

**Component:** Custom ext_authz with External State (Redis/Memcached)

**Architecture:**

```yaml
---
# Redis for nonce storage
apiVersion: v1
kind: Pod
metadata:
  name: redis-cache
  namespace: default
spec:
  containers:
  - name: redis
    image: redis:latest
    ports:
    - containerPort: 6379
---
# ext_authz server deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: replay-detection-authz
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: replay-detection-authz
  template:
    metadata:
      labels:
        app: replay-detection-authz
    spec:
      containers:
      - name: authz
        image: replay-detection-authz:latest
        ports:
        - containerPort: 9000
        env:
        - name: REDIS_URL
          value: "redis://redis-cache:6379"
        - name: NONCE_TTL_SECONDS
          value: "3600"
---
# Service for ext_authz
apiVersion: v1
kind: Service
metadata:
  name: replay-detection-authz
  namespace: default
spec:
  selector:
    app: replay-detection-authz
  ports:
  - name: grpc
    port: 9000
    targetPort: 9000
---
# Mesh config
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |
    extensionProviders:
    - name: replay-detection
      envoyExtAuthzGrpc:
        service: replay-detection-authz.default.svc.cluster.local
        port: 9000
        timeout: 2s
---
# Authorization policy
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: replay-attack-protection
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: ingressgateway
  action: CUSTOM
  provider:
    name: replay-detection
  rules:
  - to:
    - operation:
        methods: ["POST"]
        paths: ["/api/transfer", "/api/payment"]
```

**Custom ext_authz Implementation:**

```go
package main

import (
    "context"
    "time"
    "github.com/go-redis/redis/v8"
    authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
)

var redisClient *redis.Client

func Authorize(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
    
    headers := req.Attributes.Request.Http.Headers
    
    // Extract nonce and timestamp
    nonce := headers["x-nonce"]
    timestamp := headers["x-timestamp"]
    requestID := headers["x-request-id"]  // Unique per request
    
    // Stage 1: Timestamp Freshness Check
    // ===================================
    
    clientTimestamp, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return Deny("invalid timestamp format")
    }
    
    currentTime := time.Now().Unix()
    timeDifference := currentTime - clientTimestamp
    
    // Reject if older than 5 minutes or in the future
    if timeDifference > 300 { // 5 minutes
        return Deny("request too old: timestamp=%d, now=%d", 
                   clientTimestamp, currentTime)
    }
    
    if timeDifference < -60 { // 1 minute in future
        return Deny("request timestamp in future: possible clock skew")
    }
    
    // Stage 2: Nonce Uniqueness Check
    // ================================
    
    // Check if nonce was already used
    nonceKey := "nonce:" + nonce
    
    // Try to SET nonce (only if it doesn't exist)
    result := redisClient.SetNX(ctx, nonceKey, requestID, 
                              time.Duration(3600)*time.Second)
    
    if !result.Val() {
        // Nonce already exists in Redis
        return Deny("replay attack detected: nonce already used")
    }
    
    if result.Err() != nil {
        // Redis error - fail safe (deny)
        return Deny("error checking nonce: %v", result.Err())
    }
    
    // Nonce is new and stored
    
    // Stage 3: Request ID Deduplication
    // ==================================
    
    // Also track by request ID for additional protection
    requestKey := "request:" + requestID
    
    result = redisClient.SetNX(ctx, requestKey, "true", 
                              time.Duration(3600)*time.Second)
    
    if !result.Val() {
        return Deny("duplicate request detected: request-id already processed")
    }
    
    // Stage 4: Rate Limiting per User
    // ================================
    
    userID := headers["x-user-id"]
    rateLimitKey := "rate-limit:" + userID
    
    // Allow max 10 requests per minute
    count := redisClient.Incr(ctx, rateLimitKey)
    if count.Val() == 1 {
        // First request in this minute, set expiry
        redisClient.Expire(ctx, rateLimitKey, 60*time.Second)
    }
    
    if count.Val() > 10 {
        return Deny("rate limit exceeded: %d requests in 1 minute", count.Val())
    }
    
    // All checks passed - request is fresh and unique
    return Allow()
}

func Deny(format string, args ...interface{}) (*authv3.CheckResponse, error) {
    return &authv3.CheckResponse{
        Status: status.New(codes.PermissionDenied, 
                          fmt.Sprintf(format, args...)).Proto(),
    }, nil
}

func Allow() (*authv3.CheckResponse, error) {
    return &authv3.CheckResponse{
        Status: status.OK(context.Background()).Proto(),
    }, nil
}
```

**How ext_authz Enforces Replay Prevention:**

```
First Request (T1):
────────────────
1. Request arrives with nonce=abc123, timestamp=1712859600
2. ext_authz checks:
   ✓ Timestamp is fresh (within 5 minutes)
   ✓ Nonce doesn't exist in Redis
3. Store: redis.SET("nonce:abc123", requestID, 3600s)
4. ✓ ALLOW → Request processed

Second Request (T2, same body):
──────────────────────────────
1. Same request replayed with nonce=abc123
2. ext_authz checks:
   ✓ Timestamp is still fresh (same as before)
   ✗ Nonce ALREADY EXISTS in Redis
3. redis.SETNX fails (key exists)
4. ✗ DENY "replay attack detected"

Why This Works:
───────────────
- Redis is stateful across requests
- Once nonce is used, it's marked in Redis with TTL
- Even if token is valid, nonce prevents reuse
- TTL prevents unbounded Redis growth
- Multiple ext_authz replicas share same Redis state
```

**Testing Replay Protection:**

```bash
# First request - should succeed
curl -X POST https://api.example.com/api/transfer \
  -H "Authorization: Bearer $VALID_TOKEN" \
  -H "X-Nonce: nonce_12345" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Request-ID: req_001" \
  -d '{"amount": 50, "recipient": "store-xyz"}'
# Result: 200 OK ✓

# Replay with same nonce - should fail
curl -X POST https://api.example.com/api/transfer \
  -H "Authorization: Bearer $VALID_TOKEN" \
  -H "X-Nonce: nonce_12345"  ← Same nonce!
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Request-ID: req_001" \
  -d '{"amount": 50, "recipient": "store-xyz"}'
# Result: 403 Forbidden (replay attack detected) ✓

# New request with new nonce - should succeed
curl -X POST https://api.example.com/api/transfer \
  -H "Authorization: Bearer $VALID_TOKEN" \
  -H "X-Nonce: nonce_67890"  ← Different nonce
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Request-ID: req_002" \
  -d '{"amount": 50, "recipient": "store-xyz"}'
# Result: 200 OK ✓
```

---

## Summary: Feature Matrix

| Attack Scenario | Istio Feature | Component | Enforcement Method | Validation Layer |
|---|---|---|---|---|
| **Header Injection** | AuthorizationPolicy | Security Policy | Header allowlist/denylist | Envoy filter |
| **JWT Modification** | RequestAuthentication + AuthorizationPolicy | JWT/Claims | Signature verification + claims validation | Envoy filter + claims extraction |
| **Body Tampering** | Custom ext_authz | gRPC provider | HMAC-SHA256 validation | External service |
| **Replay Attacks** | Custom ext_authz | gRPC provider + Redis | Nonce tracking + timestamp validation | External service + state store |

---

## Layered Defense Strategy

For maximum protection, combine all mechanisms:

```yaml
---
# Layer 1: mTLS (TLS handshake level)
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: secure-gateway
spec:
  servers:
  - port:
      number: 443
      protocol: HTTPS
    tls:
      mode: MUTUAL  # Client must have certificate
---
# Layer 2: JWT Signature (Token level)
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-validation
spec:
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
---
# Layer 3: Claims Validation (Authorization level)
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: claims-validation
spec:
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    when:
    - key: request.auth.claims[role]
      values: ["admin", "viewer"]
---
# Layer 4: Custom Body Validation (Request level)
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: body-validation
spec:
  action: CUSTOM
  provider:
    name: body-authz-server
---
# Layer 5: Replay Attack Prevention (State level)
# (Implemented in same ext_authz server)
```

**Defense In Depth Benefits:**

```
Attack Progression:

Layer 1: ✗ No valid certificate → TLS handshake fails
         ↓
Layer 2: ✗ Invalid JWT signature → Token rejected
         ↓
Layer 3: ✗ Claims don't match policy → Authorization denied
         ↓
Layer 4: ✗ Body HMAC doesn't match → Tampering detected
         ↓
Layer 5: ✗ Nonce already seen → Replay attack detected

Result: Attack is blocked at FIRST layer of defense
Multiple layers prevent bypass of single mechanism
```

---

*Related posts:*
- *[Tamper Detection at the Istio Gateway Layer](/blog/tamper-detection-istio-gateway/)*
- *[HMAC in Istio: Series 1/2 - Understanding HMAC and mTLS](/blog/hmac-in-istio-part-1/)*
- *[HMAC in Istio: Series 2/2 - Advanced Scenarios, Debugging, and Performance](/blog/hmac-in-istio-part-2/)*
- *[Building a Custom ext_authz Server for Istio](/blog/istio-ext-authz-guide/)*
