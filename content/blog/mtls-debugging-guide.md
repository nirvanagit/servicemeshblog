---
title: "The Definitive Guide to Debugging mTLS in Istio"
date: 2026-01-15
draft: false
tags: ["istio", "mtls", "security", "debugging", "spiffe", "certificates"]
categories: ["security"]
author: "Service Mesh Blog"
description: "Systematic approach to diagnosing mTLS handshake failures, certificate issues, and RBAC policy mismatches in Istio — with runbooks and real error messages."
cover:
  image: ""
  alt: "mTLS Certificate Chain"
  caption: ""
  relative: false
ShowToc: true
TocOpen: false
---

## Why mTLS Debugging is Hard

Mutual TLS failures are notoriously difficult to diagnose because errors surface at multiple layers:

- **Certificate validation** — expired certs, wrong SAN, untrusted CA
- **TLS negotiation** — cipher suite mismatch, protocol version mismatch
- **RBAC policy** — cert is valid but identity is not authorized
- **PeerAuthentication mode** — STRICT vs PERMISSIVE misconfiguration
- **Proxy misconfiguration** — sidecar not injected, wrong port mapping

This guide gives you a systematic runbook to work through each layer.

## Layer 1: Verify Sidecar Injection

Before debugging mTLS itself, confirm both pods have Envoy sidecars:

```bash
# Check pod has 2 containers (app + istio-proxy)
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].name}'
# Expected: myapp istio-proxy

# If only 1 container, sidecar injection is disabled
kubectl get namespace <namespace> --show-labels | grep istio-injection
# Should show: istio-injection=enabled
```

If injection is disabled for specific pods, check for the opt-out annotation:

```bash
kubectl get pod <pod-name> -o jsonpath='{.metadata.annotations.sidecar\.istio\.io/inject}'
# "false" means injection was explicitly disabled
```

## Layer 2: Check PeerAuthentication Policy

The most common mTLS misconfiguration is a `STRICT` PeerAuthentication on a namespace that still has legacy pods without sidecars:

```bash
# List all PeerAuthentication policies
kubectl get peerauthentication --all-namespaces

# Check the effective policy for a specific namespace
kubectl get peerauthentication -n <namespace> -o yaml
```

```yaml
# STRICT mode — all traffic MUST be mTLS
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# PERMISSIVE mode — allows both mTLS and plain text
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: PERMISSIVE
```

**Tip**: Start with PERMISSIVE, verify all traffic is mTLS using Kiali, then switch to STRICT.

## Layer 3: Inspect the Certificate Chain

Use `istioctl` to inspect what certificate a proxy is presenting:

```bash
# Check the cert Envoy is using for workload identity
istioctl proxy-config secret <pod-name>.<namespace>

# Example output:
# RESOURCE NAME     TYPE           STATUS     VALID CERT  SERIAL NUMBER  NOT AFTER                NOT BEFORE
# default           Cert Chain     ACTIVE     true        ...            2026-01-15T12:00:00Z     2026-01-14T12:00:00Z
# ROOTCA            CA             ACTIVE     true        ...            2036-01-13T12:00:00Z     2026-01-13T12:00:00Z
```

Dive deeper to see the full certificate:

```bash
# Dump full cert details
istioctl proxy-config secret <pod-name>.<namespace> -o json | \
  jq -r '.dynamicActiveSecrets[0].secret.tlsCertificate.certificateChain.inlineBytes' | \
  base64 -d | openssl x509 -text -noout

# Key fields to check:
# Subject Alternative Name: URI:spiffe://cluster.local/ns/<namespace>/sa/<service-account>
# Validity: Not Before / Not After
# Issuer: O=cluster.local (Istiod CA)
```

## Layer 4: Real-Time TLS Debugging with Envoy Logs

Enable debug logging for TLS on a specific pod:

```bash
# Increase log level for TLS subsystem
istioctl proxy-config log <pod-name>.<namespace> --level tls:debug,rbac:debug

# Stream the logs
kubectl logs <pod-name> -n <namespace> -c istio-proxy -f | grep -E "(TLS|RBAC|mTLS)"
```

Common error patterns to look for:

```
# Certificate SAN mismatch
[debug][tls] peer certificate SAN "spiffe://cluster.local/ns/default/sa/frontend"
did not match expected "spiffe://cluster.local/ns/production/sa/frontend"

# Expired certificate
[error][tls] TLS error: 268435581:SSL routines:OPENSSL_internal:CERTIFICATE_VERIFY_FAILED

# RBAC denial (cert valid but not authorized)
[debug][rbac] checking connection: requestedServerName=outbound_.8080_._.myservice.production.svc.cluster.local
[debug][rbac] connection denied, rbac policy denied
```

## Layer 5: Check AuthorizationPolicy

If the certificate is valid but traffic is being denied, the issue is likely an `AuthorizationPolicy`:

```bash
# List all authorization policies
kubectl get authorizationpolicy --all-namespaces

# Check if a DENY policy is catching legitimate traffic
kubectl get authorizationpolicy -n <namespace> -o yaml
```

A common mistake is a catch-all DENY that blocks health check probes:

```yaml
# Problematic: this denies Kubernetes health probes
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  action: DENY
  rules:
  - {}  # Denies ALL traffic including kube-proxy health checks!
```

Fix by allowing specific sources:

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/production/sa/frontend"]
    to:
    - operation:
        methods: ["GET", "POST"]
        ports: ["8080"]
```

## Layer 6: Use `istioctl analyze`

Istio's built-in analyzer catches many common misconfigurations:

```bash
# Analyze a specific namespace
istioctl analyze -n production

# Example warnings:
# Warning [IST0108] (VirtualService ...) Destination host "myservice" not found
# Warning [IST0103] (PeerAuthentication ...) PeerAuthentication "default" has STRICT mode but
#         pod "legacy-app-xxxx" does not have Istio sidecar
```

## Quick Reference: Diagnostic Commands

```bash
# Full proxy status overview
istioctl proxy-status

# Check xDS sync for a specific pod
istioctl proxy-status <pod>.<namespace>

# Verify DestinationRule TLS settings
kubectl get destinationrule --all-namespaces -o yaml | grep -A5 "tls:"

# Test connectivity with curl through the mesh
kubectl exec -it <source-pod> -n <namespace> -c istio-proxy -- \
  curl -v --resolve myservice:8080:$(kubectl get svc myservice -n production -o jsonpath='{.spec.clusterIP}') \
  http://myservice:8080/health
```

## mTLS Migration Checklist

When migrating a namespace to STRICT mTLS:

- [ ] All pods in the namespace have `istio-proxy` injected
- [ ] `PeerAuthentication` is PERMISSIVE while testing
- [ ] No existing `DestinationRule` with `tls.mode: DISABLE`
- [ ] Kubernetes readiness/liveness probes are excluded (Istio auto-handles this for HTTP probes since 1.9)
- [ ] External traffic (Ingress Gateway) has appropriate TLS termination config
- [ ] `istioctl analyze` shows no errors
- [ ] Grafana/Kiali show 100% mTLS traffic in the namespace
- [ ] Switch `PeerAuthentication` to STRICT
- [ ] Monitor error rate for 30 minutes

---

*Got a specific mTLS error not covered here? Open an issue or PR.*
