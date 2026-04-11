---
title: "HMAC in Istio: Part 1 - Understanding HMAC and Its Role in mTLS"
date: 2026-04-10
draft: false
tags: ["hmac", "cryptography", "mtls", "security", "tls"]
categories: ["security"]
author: "Service Mesh Blog"
description: "Part 1 of our HMAC series: Learn how HMAC (Hash-Based Message Authentication Code) works and how Istio uses it to guarantee message authenticity and integrity in mTLS connections."
ShowToc: true
TocOpen: false
---

## What is HMAC?

**HMAC** stands for **Hash-Based Message Authentication Code**. It's a cryptographic technique that computes a unique "fingerprint" of a message using a secret key and a hash function. This fingerprint proves two critical things:

1. **Authenticity**: The message came from someone who knows the secret key
2. **Integrity**: The message hasn't been modified since it was created

Think of HMAC like a tamper-evident seal on an envelope. When you seal an envelope with a special lock that only you and the recipient have a key for, anyone who opens it will break the seal—and you'll immediately know someone tampered with it.

---

## How HMAC Works: Step by Step

HMAC combines three core components:

1. **A secret key** (known only to sender and receiver)
2. **A hash function** (like SHA-256)
3. **The message** being authenticated

### The Algorithm

HMAC follows the standard defined in RFC 2104:

```
HMAC(K, M) = H((K ⊕ opad) || H((K ⊕ ipad) || M))
```

Where:
- `K` = secret key
- `M` = message
- `H` = hash function (SHA-256, SHA-512, etc.)
- `⊕` = XOR (bitwise exclusive OR operation)
- `ipad` = inner padding constant (byte 0x36 repeated)
- `opad` = outer padding constant (byte 0x5C repeated)
- `||` = concatenation (joining together)

This looks complex, but the concept is simple: apply the hash function twice with different key padding to prevent certain attacks.

### Concrete Example

Let's walk through a real scenario with actual numbers.

**Setup (both parties know):**
- Shared secret key: `mysecret123`
- Message: `"Hello Bob, transfer $100"`
- Hash function: SHA-256

**Step 1: Prepare the Key**

```
Original key: "mysecret123" (11 characters)
SHA-256 output is 32 bytes
Pad key to 32 bytes: 
  "mysecret123" + 21 zero bytes = 32 bytes total
```

**Step 2: Compute Inner Hash**

```
Create inner-padded key by XOR with ipad (0x36):
padded_key ⊕ ipad = 32 bytes (each byte XORed with 0x36)

Concatenate with message:
(padded_key ⊕ ipad) || "Hello Bob, transfer $100"

Hash the result:
H_inner = SHA256((padded_key ⊕ ipad) || message)
        = a3f4b2c7d1e8... (32 bytes in hex)
```

**Step 3: Compute Outer Hash**

```
Create outer-padded key by XOR with opad (0x5C):
padded_key ⊕ opad = 32 bytes (each byte XORed with 0x5C)

Concatenate with inner hash result:
(padded_key ⊕ opad) || H_inner

Hash again:
HMAC = SHA256((padded_key ⊕ opad) || H_inner)
     = 7c2e9f1a5b3d... (32 bytes in hex)
```

**Step 4: Send Message with HMAC**

```
Message:  "Hello Bob, transfer $100"
HMAC:     "7c2e9f1a5b3d..."
Sender transmits both together
```

---

## Verification: How the Receiver Checks Authenticity

When the recipient receives the message, they verify it hasn't been tampered with:

**Bob's verification process:**

```
1. Bob receives:
   Message: "Hello Bob, transfer $100"
   HMAC:    "7c2e9f1a5b3d..."

2. Bob knows the secret key: "mysecret123"

3. Bob recomputes the HMAC using the exact same algorithm:
   HMAC_computed = HMAC-SHA256("mysecret123", 
                               "Hello Bob, transfer $100")
                 = "7c2e9f1a5b3d..."

4. Bob compares:
   Received HMAC:  "7c2e9f1a5b3d..."
   Computed HMAC:  "7c2e9f1a5b3d..."
   
   They match! ✓
   
   Conclusion: Message is authentic and unmodified
```

### What Happens if the Message is Tampered With?

```
Attacker intercepts and modifies the message:
Original: "Hello Bob, transfer $100"
Modified: "Hello Bob, transfer $1,000,000"

Attacker sends:
Message: "Hello Bob, transfer $1,000,000"
HMAC:    "7c2e9f1a5b3d..." (original, unchanged)

Bob receives and verifies:

1. Bob recomputes HMAC with the received message:
   HMAC_computed = HMAC-SHA256("mysecret123",
                               "Hello Bob, transfer $1,000,000")
                 = "5a1b3d7e2c9f..." (different!)

2. Bob compares:
   Received HMAC:  "7c2e9f1a5b3d..."
   Computed HMAC:  "5a1b3d7e2c9f..."
   
   They DON'T match! ✗
   
   Conclusion: Message was tampered with!
   Action: REJECT the message
```

The attacker cannot fix the HMAC because they don't know the secret key.

---

## Why Two Hash Operations?

You might wonder: why not just hash the message once with the key?

The RFC 2104 design uses two hash operations with different key padding for important security reasons:

### 1. Length Extension Attack Prevention

Some hash functions are vulnerable to **length extension attacks**. An attacker can:
- Know the hash output of a message
- Append additional data
- Compute the hash of the extended message without knowing the original key

```
Original: H(key || message) = abc123...
Attacker: Appends " || malicious_data"
Attacker: Computes H(key || message || malicious_data)
Attack: Works because hash functions process data sequentially
```

The outer hash with a different padding breaks this:

```
HMAC: H(opad || H(ipad || message))
Even if attacker knows H(ipad || message), they can't compute
the outer hash without knowing the key for opad-padding
Attack prevented ✓
```

### 2. Key Exposure Prevention

Using different paddings (ipad vs opad) ensures:
- The key is never directly fed to the hash function
- If the hash function has certain weaknesses, the HMAC remains secure
- The key is "hidden" inside the padded values

---

## Key Properties of HMAC

| Property | What It Means |
|----------|--------------|
| **Deterministic** | Same key + message always produces the same HMAC output |
| **One-way** | You cannot reverse an HMAC to recover the key or message |
| **Avalanche effect** | Changing even 1 bit in the message completely changes the HMAC |
| **Fixed output** | HMAC-SHA256 always produces 32 bytes, regardless of message size |
| **Fast** | Much faster than public-key cryptography (signatures) |
| **Requires shared secret** | Both parties must know the secret key to verify |
| **Unforgeable** | Without the key, an attacker cannot create a valid HMAC |

---

## HMAC vs Other Cryptographic Techniques

### HMAC vs Encryption

```
Encryption (e.g., AES-256):
├─ Purpose: Hide message content
├─ Example: "transfer $100" → encrypted bytes (gibberish)
└─ Problem: Doesn't prove who sent it or if it was modified

HMAC:
├─ Purpose: Prove authenticity and detect tampering
├─ Example: Message remains readable, but has a fingerprint
└─ Problem: Doesn't hide the message content

Authenticated Encryption (Encryption + HMAC):
├─ Purpose: Hide content AND prove authenticity
├─ Example: TLS uses this (AES-256-GCM)
└─ Benefit: Security + Privacy
```

In practice, you usually use **both together**: encryption hides the message, HMAC proves it's authentic.

### HMAC vs Digital Signature

```
HMAC:
├─ Key type: Symmetric (secret, shared)
├─ Who can verify: Only sender and receiver
├─ Speed: Very fast
├─ Use case: Private communication between two parties
└─ Example: API authentication, TLS connections

Digital Signature (public-key cryptography):
├─ Key type: Asymmetric (public/private pair)
├─ Who can verify: Anyone with the public key
├─ Speed: Slower
├─ Use case: Proving identity to the world
└─ Example: JWT tokens, digital certificates
```

**Summary table:**

| Feature | HMAC | Digital Signature |
|---------|------|-------------------|
| Keys | Symmetric (shared secret) | Asymmetric (public/private) |
| Verification audience | Sender + receiver only | Anyone (public proof) |
| Speed | Fast | Slow |
| Proves sender identity | To receiver only | To everyone |
| Non-repudiation | No | Yes |
| Typical use | Point-to-point security | Public authentication |

---

## HMAC Security Strength

The security of HMAC depends on two factors:

### 1. Key Size

```
HMAC-SHA-256 with:
├─ 128-bit key (16 bytes):  128 bits of security
├─ 256-bit key (32 bytes):  256 bits of security
└─ Shorter keys: Proportionally weaker

What does 128 bits of security mean?
└─ Requires ~2^128 attempts to forge a valid HMAC
  = ~340,000,000,000,000,000,000,000,000,000,000 attempts
  = Billions of years on current hardware
```

### 2. Hash Function Quality

```
HMAC-MD5:      Not recommended (32-bit output, hash weakened)
HMAC-SHA-1:    Deprecated (160-bit output, hash weakened)
HMAC-SHA-256:  Current standard (256-bit output)
HMAC-SHA-512:  For extra security (512-bit output)
```

**Best practice**: Use **HMAC-SHA-256** or **HMAC-SHA-512** with keys of 128 bits or larger.

---

## Where HMAC is Used

HMAC is fundamental to modern internet security:

- **TLS (Transport Layer Security)**: Every TLS connection uses HMAC to authenticate data
- **HTTPS**: HMAC protects all web traffic
- **APIs**: Secure API authentication uses HMAC (e.g., AWS Signature V4)
- **Message Queues**: RabbitMQ, Kafka use HMAC for message authentication
- **Wireless**: WPA2/WPA3 use HMAC variants
- **Service Meshes**: Istio uses HMAC within mTLS to protect all mesh traffic

---

## How HMAC is Enforced in Istio

Now that we understand HMAC, let's see how Istio leverages it for security.

### Istio's mTLS Architecture

When Istio is deployed with mTLS enabled, every service-to-service communication is protected by **TLS**, which uses **HMAC** to guarantee both encryption and authentication.

```mermaid
graph LR
    A["Client Pod<br/>(e.g., frontend)"] -->|TLS Connection| B["Envoy Sidecar<br/>(Listener)"]
    B -->|TLS Connection| C["Server Pod<br/>(e.g., backend)"]
    C -->|Envoy Sidecar<br/>Listener| D["Backend Service"]
    
    style B fill:#4f46e5,color:#fff
    style C fill:#4f46e5,color:#fff
    style A fill:#ec4899,color:#fff
    style D fill:#10b981,color:#fff
```

### The TLS Record with HMAC

Every TLS record sent between client and server includes an HMAC:

```
TLS Record Structure:
┌─────────────────────────┐
│ TLS Header              │ (5 bytes: type, version, length)
├─────────────────────────┤
│ Encrypted Data:         │
│  ├─ Plaintext message   │
│  ├─ HMAC                │ ← Authenticates the plaintext
│  └─ Padding             │
└─────────────────────────┘
```

### HMAC Computation in Istio/TLS

When a client sends a request through mTLS:

**Step 1: Client Envoy Sidecar**
```
1. Has plaintext message (HTTP request)
2. Computes HMAC using the TLS session key:
   HMAC = HMAC-SHA-256(session_key, plaintext_message)
3. Appends HMAC to the message
4. Encrypts everything with AES-256:
   ciphertext = AES-256-encrypt(message || HMAC)
5. Sends TLS record to server
```

**Step 2: Server Receives and Verifies**
```
1. Server Envoy Sidecar receives encrypted TLS record
2. Decrypts using the session key:
   plaintext = AES-256-decrypt(ciphertext)
   Now has: message || HMAC
3. Computes HMAC of the plaintext message:
   HMAC_computed = HMAC-SHA-256(session_key, message)
4. Compares:
   Received HMAC == HMAC_computed?
   
   If YES:  Message is authentic and unmodified ✓
           Process the request
   
   If NO:   Tampering detected ✗
           Close TLS connection immediately
           Log security alert
```

### The Session Key in Istio

The session key used for HMAC is derived during the **TLS handshake**:

```
TLS Handshake (mTLS between Envoy sidecars):
1. Client sends ClientHello
2. Server sends ServerHello (chooses cipher suite)
3. Both exchange certificates (mutual authentication)
4. Both perform key exchange (Diffie-Hellman, ECDH)
5. Both derive: session_key = KDF(shared_secret, nonces)
   
Result: 
├─ Both have identical session_key (secret)
├─ Each TLS record is authenticated with this key
├─ The key is unique to this connection
└─ If connection is compromised, only this session is affected
```

Istio's istiod (control plane) provisions certificates via **cert-manager**, and Envoy proxies manage the TLS handshakes automatically.

---

## Real-World Scenario: Tampering Prevention in Istio

Let's trace through a concrete example of how HMAC protects traffic:

### Normal Request (Unmodified)

```
Frontend Service (istio-ingressgateway)
    ↓
[HTTP Request with HMAC in TLS]
GET /api/users/123
Authorization: Bearer token123
    ↓
Backend Service (Envoy sidecar verifies HMAC)
    ✓ HMAC matches
    ✓ Request processed
```

### Attack Scenario: Compromised Proxy Attempt

```
Frontend Service
    ↓
[TLS Record 1: GET /api/users/123, HMAC: abc123...]
    ↓
Attacker intercepts and modifies:
GET /api/admin/secrets  ← Changed!
    ↓
[TLS Record 1: GET /api/admin/secrets, HMAC: abc123...]
    ↓
Backend Service Envoy receives

Verification:
1. Decrypt using session_key
   message = "GET /api/admin/secrets"
   received_HMAC = "abc123..."

2. Compute HMAC:
   computed_HMAC = HMAC-SHA256(session_key, "GET /api/admin/secrets")
                 = "xyz789..."

3. Compare:
   received_HMAC:  "abc123..."
   computed_HMAC:  "xyz789..."
   
   ✗ MISMATCH!
   
4. Backend Envoy:
   └─ Immediately closes TLS connection
   └─ Logs security alert
   └─ Request is REJECTED
```

The attacker cannot compute a valid HMAC because they don't have the session key.

### Why This Works

1. **Session key is derived from TLS handshake**: Only the client and server know it
2. **Handshake uses mutual authentication**: Both sides prove identity with certificates
3. **HMAC authenticates every byte**: Changing even one bit breaks the HMAC
4. **Verification is automatic**: Envoy rejects the connection if HMAC fails
5. **No exceptions**: HMAC verification is mandatory, no way to bypass it

---

## Key Takeaways

- **HMAC is a fingerprint**: It proves a message came from a known party and wasn't modified
- **Two hash operations**: Using ipad and opad padding prevents length-extension and key-recovery attacks
- **Symmetric key required**: Both sender and receiver must share the same secret key
- **One-way verification**: You can verify HMAC but can't forge it without the key
- **Istio uses HMAC in TLS**: Every mTLS record includes HMAC for authentication
- **Automatic enforcement**: Envoy proxies verify HMAC on every message; tampering is immediately detected

In **Part 2** of this series, we'll explore advanced HMAC scenarios in Istio:
- How HMAC protects against specific attack types
- Debugging HMAC failures in Istio
- Performance implications of HMAC in high-traffic environments
- Best practices for key rotation and session security

---

*Related posts:*
- *[Using Custom JWT Claims for Authorization in Istio Gateway](/blog/custom-claims-authorization-istio/)*
- *[Istio Observability: Golden Signals for Security Policies](/blog/istio-observability-control-plane/)*
- *[Building a Custom ext_authz Server for Istio](/blog/istio-ext-authz-guide/)*
