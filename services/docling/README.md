# Docling deployment boundary

`compose.yaml` pins the CPU image by registry digest (`docling-serve` release 1.29.0 at admission time), binds it to loopback, drops Linux capabilities, denies privilege escalation, uses a read-only root filesystem, and exposes an explicit health probe. Deployments must additionally deny outbound network at the platform layer and mount only isolated per-job inputs.

Start and inspect locally:

```powershell
docker compose -f services/docling/compose.yaml up -d
docker compose -f services/docling/compose.yaml ps
Invoke-WebRequest http://127.0.0.1:5001/health
```

The TypeScript conversion adapter is the only canonical caller. It validates runtime output, enforces byte/time/resource limits, stores provider-native output as a derived immutable artifact, and records the image digest, profile digest, request/response digests, warnings, timing, cost, and retries. Docling jobs and Docling MCP never become orchestration or publication authority.

Promotion of another image digest requires fixture parity, malware/parser isolation tests, output-schema validation, rollback rehearsal, and a new immutable capability-profile version.
