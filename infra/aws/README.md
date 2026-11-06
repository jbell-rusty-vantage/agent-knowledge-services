# AWS worker and Docling deployment

`knowledge-runtime.template.json` is a deployable CloudFormation template for the two long-lived runtime boundaries. It deliberately does **not** deploy the API or MCP facade; those are independent Vercel projects under `apps/api` and `apps/mcp`.

The stack requires an existing VPC with at least two private subnets, a private Route 53 hosted zone, an ACM certificate valid for the chosen Docling private DNS name, and two Secrets Manager JSON secrets. It creates:

- an ECS/Fargate cluster and independently scalable worker and Docling services;
- an internal HTTPS application load balancer and private DNS record for Docling;
- security groups that allow Docling traffic only from the worker through the load balancer;
- read-only Docling root filesystems, a bounded `/tmp` tmpfs, dropped Linux capabilities, and an image pinned by digest;
- task execution and task roles with separate responsibilities;
- secret injection from named JSON keys, CloudWatch log groups, health checks, deployment circuit breakers, autoscaling targets, and an unhealthy-target alarm.

Ingress is destination-restricted: Docling accepts port 5001 only from the internal load balancer, and the load balancer accepts 443 only from the worker security group. Outbound access is only protocol/port constrained in this baseline—worker TCP 443/5432 and Docling TCP 443 still target `0.0.0.0/0`. A production network must route these through controlled NAT, egress firewall/proxy, or private endpoints and restrict destinations to the actual database, Storage, Gateway, image, and admitted model-artifact services. The template does not claim destination-restricted egress.

The required secret JSON keys are:

| Secret parameter | JSON keys |
| --- | --- |
| `DatabaseSecretArn` | `POSTGRES_URL` |
| `WorkerRuntimeSecretArn` | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AI_GATEWAY_API_KEY` |

Both container image parameters require immutable `@sha256:` references. Build and push the worker from the repository root so the workspace-aware Dockerfile can construct the production closure:

```powershell
docker build -f apps/worker/Dockerfile -t "$env:WORKER_IMAGE" .
docker push "$env:WORKER_IMAGE"
```

Validate and deploy without placing secret values on the command line:

```powershell
aws cloudformation validate-template --template-body file://infra/aws/knowledge-runtime.template.json
aws cloudformation deploy `
  --stack-name ai-engineer-knowledge-runtime `
  --template-file infra/aws/knowledge-runtime.template.json `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides file://infra/aws/parameters.example.json
```

Copy `parameters.example.json` outside the repository and replace every example identifier. It contains ARNs and resource identifiers only, never resolved credentials. The generated private URL is returned as `DoclingBaseUrl`; configure no public DNS or public listener for Docling.

CloudFormation validation proves template structure, not managed-environment acceptance. Before shifting traffic, inspect ECS task health, the Docling target health and alarm, worker reconciliation logs, database connectivity, artifact storage connectivity, and a real conversion receipt.
