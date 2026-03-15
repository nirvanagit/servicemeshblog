---
title: "Service Mesh Blog"
layout: "hextra-home"
---

{{< hextra/hero-badge >}}
  <div class="hx-w-2 hx-h-2 hx-rounded-full hx-bg-primary-400"></div>
  <span>Free, open source</span>
  {{< icon name="arrow-circle-right" attributes="height=14" >}}
{{< /hextra/hero-badge >}}

{{< hextra/hero-headline >}}
  Service Mesh Blog
{{< /hextra/hero-headline >}}

{{< hextra/hero-subtitle >}}
  Practitioner-grade articles on Istio, Envoy, and cloud-native networking&nbsp;<br class="sm:hx-block hx-hidden" />for platform engineers and SREs.
{{< /hextra/hero-subtitle >}}

<div class="hx:flex hx:items-center hx:gap-4 hx:mt-6">
  {{< hextra/hero-button text="Read the Blog" link="blog" >}}
  <a href="about" class="not-prose hx:font-medium hx:cursor-pointer hx:px-6 hx:py-3 hx:rounded-full hx:text-center hx:inline-block hx:border hx:border-gray-300 hx:text-gray-700 hx:hover:border-gray-400 hx:hover:text-gray-900 hx:transition-all hx:ease-in hx:duration-200">About</a>
</div>

<div class="hx:mt-12"></div>

{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="Operations"
    subtitle="Upgrades, rollbacks, multi-cluster federation, performance tuning, and day-2 operational runbooks for production meshes."
    link="/categories/operations"
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="cog"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(239,68,68,0.12),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Traffic Management"
    subtitle="Routing, load balancing, retries, circuit breaking, and progressive delivery — with Istio and Envoy."
    link="/categories/traffic-management"
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="switch-horizontal"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(99,102,241,0.12),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Security"
    subtitle="mTLS, SPIFFE/SPIRE, zero-trust authorization, certificate management, and hardening service-to-service comms."
    link="/categories/security"
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="shield-check"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(16,185,129,0.12),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Observability"
    subtitle="Distributed tracing, golden signals, service graphs, and making sense of mesh telemetry at scale."
    link="/categories/observability"
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="chart-bar"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(245,158,11,0.12),hsla(0,0%,100%,0));"
  >}}
{{< /hextra/feature-grid >}}
