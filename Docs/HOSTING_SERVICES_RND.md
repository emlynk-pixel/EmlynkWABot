# Hosting Services R&D — EmlynkWABot

**Project:** EmlynkWABot  
**Document type:** Hosting Research, Analysis & Recommendation  
**Research date:** 07 October 2026  
**Status:** R&D / Architecture decision support  

> **Pricing note:** Hosting prices, quotas, free tiers, and product limits change frequently. Prices in this document are based on provider information available on 07 October 2026 and are shown in USD unless stated otherwise. Final production approval should use the provider's live pricing calculator with measured staging traffic.

---

## 1. Executive Summary

EmlynkWABot is not a normal static website. It is a business application with multiple workload types:

- React + TypeScript + Vite Admin Panel
- Node.js + Express backend/API
- Meta WhatsApp webhook handling
- PostgreSQL through Supabase/Supavisor
- Prisma ORM
- Candidate/client management and RBAC
- Document uploads and document processing
- Google Sheets integration
- Email/admin invitation flows
- A separate Dockerized OCR worker using Tesseract.js/PDF processing
- Staging/preview and production requirements

Because the frontend, API/webhook, database, and OCR worker have different resource requirements, choosing one hosting service for every component is not automatically the best architecture.

### Final recommendation

**Recommended architecture: Vercel + Google Cloud Run + Supabase.**

- **Vercel:** Admin frontend, CDN, Git-based preview/staging deployments, and optionally lightweight HTTP/API workloads.
- **Google Cloud Run:** OCR worker and, if the main Express API needs persistent container-style behavior or heavier processing, the production API.
- **Supabase:** Continue using the existing PostgreSQL/Supavisor database layer rather than introducing an unnecessary database migration.

This is recommended because it fits the architecture that already exists, separates CPU-heavy OCR from user-facing traffic, supports scale-to-zero, avoids maintaining a VPS, and has the lowest migration risk.

### Best alternatives

1. **Railway** — strongest simple PaaS alternative for the Express backend; excellent developer experience and transparent resource pricing.
2. **Render** — strong PaaS with web services and background workers; simple to operate, but its free tier must not be used for a production WhatsApp webhook.
3. **DigitalOcean App Platform** — predictable fixed-size application containers and simple operations; useful when predictable monthly pricing is preferred.
4. **Azure Container Apps** — technically strong serverless-container alternative to Cloud Run, but adds a new cloud ecosystem with no clear current benefit.
5. **Fly.io** — powerful container/microVM option with fine regional control, but more operational complexity than the project currently needs.
6. **AWS ECS/Fargate** — enterprise-grade and flexible, but the largest operational/architecture overhead in this shortlist for the current project stage.

---

## 2. Current Project Architecture and Hosting Context

The current application already has useful workload separation.

```text
                         +-----------------------+
                         | Admin / Staff Browser |
                         +-----------+-----------+
                                     |
                                     | HTTPS
                                     v
                         +-----------------------+
                         | React/Vite Admin UI   |
                         | Vercel deployment     |
                         +-----------+-----------+
                                     |
                                     | API calls
                                     v
                         +-----------------------+
                         | Node.js / Express API |
                         +-----+-----------+-----+
                               |           |
                   PostgreSQL  |           | OCR request
                               v           v
                     +---------+--+   +----+----------------+
                     | Supabase   |   | Google Cloud Run    |
                     | Postgres / |   | Docker OCR Worker   |
                     | Supavisor  |   | Tesseract / PDF     |
                     +------------+   +---------------------+
                               |
                               +--> Meta WhatsApp Cloud API
                               +--> Google Sheets / Google APIs
                               +--> Email / external integrations
```

### Existing architectural strengths

- OCR has already been separated from the main application.
- Database hosting is already managed rather than self-hosted.
- Git branches support development/staging/production workflows.
- Vercel provides preview deployment capability.
- Cloud Run already proves that the OCR worker can run as a container.

The hosting decision should preserve these strengths unless a measurable limitation justifies migration.

---

## 3. Hosting Requirements for EmlynkWABot

### 3.1 Critical functional requirements

A production hosting solution should support:

1. Node.js/Express applications.
2. React/Vite static assets and SPA routing.
3. Public HTTPS endpoints for Meta/WhatsApp webhooks.
4. Secure environment variables/secrets.
5. Reliable outbound connections to Supabase PostgreSQL.
6. Prisma/Supavisor connection pooling.
7. Docker/container deployment for OCR.
8. File/document upload requests.
9. CPU- and memory-intensive OCR/PDF processing.
10. Background/asynchronous work or an easy path to queues/workers.
11. Stable production URLs.
12. Staging/preview environments.
13. GitHub-based CI/CD.
14. Logging and troubleshooting.
15. Horizontal scaling.
16. Custom domains and managed TLS.
17. Rollback/redeployment capability.

### 3.2 Non-functional requirements

| Requirement | Why it matters |
|---|---|
| Reliability | WhatsApp webhooks and Admin APIs cannot depend on a developer PC or sleeping development service. |
| Security | Meta tokens, DB credentials, JWT secrets, Google credentials and email credentials are sensitive. |
| Low operational overhead | The team should focus on the product instead of patching Linux servers. |
| Burst scaling | Document/OCR volume can arrive in bursts. |
| Cost control | Early production traffic may be low or irregular. |
| Isolation | OCR must not starve the Admin/API process of CPU/RAM. |
| Observability | Authentication, webhook, DB, and OCR errors need usable logs. |
| Asia-friendly regions | The system is operated from Sri Lanka and may serve regional workloads. |
| Maintainability | Deployment should be understandable to the existing development team. |

---

## 4. Evaluation Method

Providers are evaluated against the following project-specific criteria:

- Compatibility with the existing codebase
- Express/Node support
- Docker/container support
- Suitability for OCR
- Background worker support
- Request/runtime limits
- Scale-to-zero and autoscaling
- Cold-start behavior
- Database connectivity
- GitHub CI/CD
- Preview/staging workflow
- Logs/monitoring
- Secrets management
- Regional availability
- Cost at low and moderate traffic
- Cost predictability
- Operational complexity
- Migration effort
- Vendor lock-in
- Future scalability

The final score is **not a universal provider ranking**. It is an assessment for this project's current architecture.

---

# 5. Option A — Google Cloud Run

**Official:** https://cloud.google.com/run  
**Pricing:** https://cloud.google.com/run/pricing  
**Quotas:** https://cloud.google.com/run/quotas  

## 5.1 What it is

Cloud Run is Google's fully managed container runtime. The application is packaged as a container, while Google manages the underlying servers, scaling and routing.

This is particularly relevant because EmlynkWABot's OCR worker is already Dockerized and deployed on Cloud Run.

## 5.2 Pricing model

Cloud Run is primarily usage-based. Google states that resources are billed in small time increments and a request-based service can benefit from a monthly free tier.

The published request-based free tier (based on Tier 1/us-central1 pricing) includes approximately:

- First **180,000 vCPU-seconds/month**
- First **360,000 GiB-seconds of memory/month**
- First **2 million requests/month**

Google's own pricing example for a public API receiving **10 million requests/month**, 400 ms average latency, 1 vCPU, 512 MiB RAM and concurrency 20 estimates **$13.69/month** in europe-west1 under the stated assumptions. This is an example, not an Emlynk quote.

Actual Emlynk cost will depend on region, CPU/RAM, request duration, concurrency, minimum instances and network egress.

## 5.3 Strengths for Emlynk

### Native fit for OCR

OCR/PDF processing benefits from:

- Container control
- CPU/RAM configuration
- Native dependencies
- Longer execution windows than typical short serverless functions
- Independent scaling

This is the strongest reason to keep OCR on Cloud Run.

### Scale-to-zero

A worker with irregular document traffic does not need a continuously running VM. When idle, it can scale down, reducing compute cost.

### Independent services

A clean production design can use separate services:

```text
emlynk-api
emlynk-ocr-worker
future-background-worker
```

This prevents OCR load from directly consuming the API's process resources.

### Mature Google Cloud ecosystem

Future integrations can use:

- Artifact Registry
- Cloud Logging
- Cloud Monitoring
- Secret Manager
- Cloud Tasks
- Pub/Sub
- Cloud Scheduler
- IAM/service accounts

### Good path to asynchronous OCR

If document volume grows, the API can acknowledge the upload quickly and enqueue processing rather than waiting for OCR synchronously.

## 5.4 Limitations / trade-offs

- More cloud concepts than Railway/Render: IAM, projects, billing, Artifact Registry and container configuration.
- Scale-to-zero may produce cold starts.
- Keeping a minimum warm instance improves latency but creates continuous cost.
- Pricing is less intuitive than a fixed $10/$20 server plan.
- Network egress and cross-region architecture need attention.
- A managed container platform still requires sensible application health checks, concurrency and resource settings.

## 5.5 Project suitability

**Excellent for OCR. Excellent for the main Express API if the team wants a containerized backend.**

**Recommendation:** Keep the OCR worker here. Cloud Run is also the preferred migration target if the main backend outgrows or conflicts with Vercel's execution model.

---

# 6. Option B — Vercel

**Official:** https://vercel.com  
**Pricing:** https://vercel.com/pricing  
**Limits:** https://vercel.com/docs/limits  

## 6.1 What it is

Vercel is highly optimized for frontend delivery, Git-based deployment, previews, CDN/edge delivery and managed function compute.

The Emlynk Admin frontend is an excellent match for Vercel.

## 6.2 Current pricing snapshot

Published plans currently include:

- **Hobby: $0/month** — positioned for personal projects.
- **Pro: $20/month** — includes **$20 usage credit**, collaboration features, spend management and production-oriented capabilities.
- **Enterprise: custom pricing**.

The current pricing page lists included Pro compute/network allocations and usage rates. These should be rechecked when production traffic is known.

## 6.3 Strengths for Emlynk

### Excellent frontend hosting

For the React/Vite Admin Panel:

- Global CDN
- HTTPS
- Git integration
- Automatic deployments
- Preview URLs
- Custom domains
- Fast static asset delivery
- Rollback/redeployment workflow

### Excellent staging workflow

The project's `stage` branch can create a testable Preview environment before code reaches production.

### Low frontend operational overhead

No web server or reverse proxy needs to be maintained for the Admin SPA.

### Strong developer experience

Deployments are tightly integrated with Git and easy for a small team to inspect.

## 6.4 Limitations / trade-offs

### Not the ideal home for heavy OCR

Even though Vercel's compute platform is much more capable than older serverless models, OCR is still a better conceptual fit for a dedicated container runtime where CPU, memory, dependencies and execution behavior are explicit.

### Serverless/function execution model

A traditional Express application may need adaptation to serverless behavior. Long-running work, process-local state, filesystem assumptions and persistent workers should not be designed as if the runtime were a permanent VPS.

### Database connection management

Serverless scale can create many concurrent database connections if pooling is not configured correctly. Supavisor helps, but connection behavior still needs monitoring.

### Filesystem persistence

Persistent application documents should live in durable storage, not a function's local filesystem.

## 6.5 Project suitability

**Excellent for Admin frontend and Preview/staging. Good for lightweight APIs. Not recommended as the sole execution platform for OCR.**

---

# 7. Option C — Railway

**Official:** https://railway.com  
**Pricing:** https://railway.com/pricing  
**Pricing docs:** https://docs.railway.com/pricing  

## 7.1 What it is

Railway is a developer-focused PaaS for applications, containers, databases and services. It offers a more conventional persistent-service experience than frontend-focused serverless hosting.

## 7.2 Current pricing

Published plan pricing:

| Plan | Base price | Intended use |
|---|---:|---|
| Free | $0/month | Experimentation, $1 monthly resource allowance |
| Hobby | $5/month | Personal/small projects |
| Pro | $20/month | Production apps and teams |
| Enterprise | Custom | Enterprise/compliance/support |

Railway states the paid subscription amount counts toward resource usage. Published container resource rates are approximately:

- RAM: **$10 / GB / month**
- CPU: **$20 / vCPU / month**
- Egress: **$0.05 / GB**
- Volume storage: **$0.15 / GB / month**

Compute is metered rather than forcing one fixed VM size.

## 7.3 Strengths

- Very easy Node/Express deployment.
- GitHub integration and automatic deployment.
- Docker support.
- Environment variable management.
- Familiar long-running-service mental model.
- Less GCP infrastructure knowledge required.
- Resource usage is clearly documented.
- Strong option for a team that wants to simplify backend operations.

## 7.4 Limitations / trade-offs

- It introduces a new hosting provider when Cloud Run already works.
- Always-active CPU/RAM workloads can accumulate usage cost.
- Smaller native cloud ecosystem than Google Cloud/AWS/Azure.
- Moving OCR provides little value unless Cloud Run has a measured problem.
- Production team features push the project toward Pro rather than the cheaper Hobby tier.

## 7.5 Project suitability

**Very good for the Express API; good for workers.**

If management wants a simpler single PaaS for the Node backend, Railway is the strongest alternative in this analysis.

---

# 8. Option D — Render

**Official:** https://render.com  
**Pricing:** https://render.com/pricing  
**Free tier:** https://render.com/docs/free  

## 8.1 What it is

Render provides static sites, web services, private services, background workers, cron jobs and managed data services with Git-based deployment.

## 8.2 Pricing and production implications

Render currently has free web services for evaluation, but its documentation explicitly says **not to use free instances for production applications**.

Important free-tier behavior:

- Free web service spins down after **15 minutes** without inbound HTTP/WebSocket traffic.
- Spin-up can take about **one minute**.
- **750 free instance hours/workspace/month**.
- Ephemeral filesystem.
- No scaling beyond one instance on free compute.
- No persistent disk on free web services.
- Free PostgreSQL is **1 GB** and expires after **30 days**.

A Render July 2026 cost example states an always-on Starter web service plus a small Basic PostgreSQL instance was around **$13/month** before bandwidth/storage growth at that time. This is an example and should not replace the current pricing page.

## 8.3 Strengths

- Easy Node/Express deployment.
- Background workers are a first-class concept.
- Git-based deployments.
- Health checks.
- Managed TLS/custom domains.
- Lower operational complexity than raw cloud infrastructure.
- Good choice for teams that value simplicity.

## 8.4 Limitations / trade-offs

### Free tier is unsuitable for production WhatsApp webhooks

A service that sleeps and can take around a minute to wake is not appropriate for a production webhook endpoint.

### Production requires paid compute

The attractive free tier is mainly a development/demo option.

### Smaller ecosystem than hyperscale clouds

Complex queues, IAM, eventing and enterprise infrastructure may require additional services.

### Ephemeral local storage

Documents must use durable object storage or another persistent service.

## 8.5 Project suitability

**Good production PaaS if paid compute is selected.** Railway is slightly preferred for this project, while Cloud Run remains preferred overall because it is already integrated.

---

# 9. Option E — DigitalOcean App Platform

**Official:** https://www.digitalocean.com/products/app-platform  
**Pricing docs:** https://docs.digitalocean.com/products/app-platform/details/pricing/  
**Limits:** https://docs.digitalocean.com/products/app-platform/details/limits/  

## 9.1 What it is

DigitalOcean App Platform is a managed PaaS that deploys applications from Git repositories or container images and handles builds, deployments and scaling.

## 9.2 Current pricing examples

Current published shared-CPU container plans include:

| CPU / RAM | Monthly price | Included bandwidth |
|---|---:|---:|
| 1 shared vCPU / 512 MiB | $5 | 50 GiB |
| 1 shared vCPU / 1 GiB fixed | $10 | 100 GiB |
| 1 shared vCPU / 1 GiB | $12 | 150 GiB |
| 1 shared vCPU / 2 GiB | $25 | 200 GiB |
| 2 shared vCPU / 4 GiB | $50 | 250 GiB |

Dedicated CPU plans cost more but can support autoscaling. Extra outbound transfer is currently documented at **$0.02/GiB**.

## 9.3 Relevant limitations

- Local container filesystem is not persistent.
- Local filesystem is limited to approximately **4 GiB**.
- File uploads time out after **600 seconds**.
- App Platform does **not support volumes**.
- Builds time out after **1 hour**.
- CPU autoscaling is limited to dedicated CPU components; request autoscaling has its own restrictions.

## 9.4 Strengths

- Simple, understandable fixed-size pricing.
- Git/container deployment.
- Easier than AWS/GCP infrastructure for a small team.
- Useful included bandwidth.
- Managed platform removes VM administration.
- Good Node/Express compatibility.

## 9.5 Limitations / trade-offs

- Less attractive scale-to-zero economics for irregular OCR than Cloud Run.
- No persistent App Platform volumes.
- Advanced autoscaling requires more expensive configurations.
- Adds migration work with no immediate feature that the current stack lacks.

## 9.6 Project suitability

**Good alternative when predictable monthly container pricing is more important than scale-to-zero.**

---

# 10. Option F — Azure Container Apps

**Official:** https://azure.microsoft.com/products/container-apps/  
**Pricing:** https://azure.microsoft.com/pricing/details/container-apps/  

## 10.1 What it is

Azure Container Apps is Microsoft's managed serverless container platform. Conceptually, it is one of the closest alternatives to Google Cloud Run for this project.

## 10.2 Current pricing model

The Consumption plan is billed by resource usage and requests. Microsoft's current published monthly free grant includes:

- **180,000 vCPU-seconds**
- **360,000 GiB-seconds**
- **2 million requests**

Apps can scale to zero, and minimum replicas can be configured when warm capacity is required.

## 10.3 Strengths

- Serverless containers.
- Scale-to-zero.
- Event-driven scaling.
- Jobs for background execution.
- Strong Azure enterprise ecosystem.
- Good fit for Node and Docker workloads.
- Comparable architectural model to Cloud Run.

## 10.4 Limitations / trade-offs

- The team already has Google Cloud Run working.
- Moving would require learning Azure identity, deployment, registry, monitoring and billing.
- Adds another cloud ecosystem without solving a current limitation.
- Enterprise capability is strong, but that strength does not automatically justify migration.

## 10.5 Project suitability

**Technically excellent, strategically unnecessary at the moment.** It is a valid contingency if the organization standardizes on Microsoft Azure.

---

# 11. Option G — Fly.io

**Official:** https://fly.io  
**Pricing:** https://fly.io/pricing  
**2026 pricing update:** https://fly.io/pricing-update/  

## 11.1 What it is

Fly.io runs applications in lightweight Machines/microVMs and offers fine-grained regional placement and container-style deployment.

## 11.2 Current pricing examples (effective October 2026)

Published example Machine prices include:

| Machine preset | Approx. monthly compute |
|---|---:|
| shared-cpu-1x / 256 MB | $2.19 |
| shared-cpu-2x / 512 MB | $4.39 |
| shared-cpu-4x / 1 GB | $8.78 |
| shared-cpu-8x / 2 GB | $17.55 |
| performance-1x / 2 GB | $33.00 |
| performance-2x / 4 GB | $66.00 |

Other current published charges include:

- Volumes: **$0.15/GB/month**
- Snapshots: **$0.08/GB/month**
- Dedicated IPv4: **$2/month**
- Asia-Pacific/Oceania/South America egress: approximately **$0.04/GB**
- India/Africa egress: approximately **$0.12/GB**

## 11.3 Strengths

- Excellent Docker/container support.
- Fine regional placement.
- More control than typical PaaS.
- Good for services needing a server-like runtime.
- Small Machines can be inexpensive.

## 11.4 Limitations / trade-offs

- More operational knowledge than Railway/Render.
- Compute, storage, IP and network costs are separate.
- Managed Postgres is comparatively expensive for a small project, though Emlynk could continue using Supabase.
- Migration does not solve a known current problem.

## 11.5 Project suitability

**Technically capable but not the most practical current choice.**

---

# 12. Option H — AWS ECS/Fargate

**Official:** https://aws.amazon.com/ecs/  
**Fargate pricing:** https://aws.amazon.com/fargate/pricing/  

## 12.1 Important 2026 product note

AWS documentation states that **AWS App Runner is closed to new customers**. AWS recommends new customers explore **Amazon ECS Express Mode**, which provisions an ECS/Fargate-based application stack.

Therefore this R&D does not recommend starting a new Emlynk architecture on App Runner.

## 12.2 What ECS/Fargate provides

Fargate runs containers without managing EC2 servers. Billing is based on requested vCPU, memory, storage, operating system/architecture and execution duration.

## 12.3 Strengths

- Enterprise-grade container platform.
- Mature IAM and networking.
- Large global cloud ecosystem.
- S3 object storage, SQS queues, CloudWatch monitoring, Secrets Manager, RDS, etc.
- Excellent long-term scaling options.
- Fargate Spot can reduce costs for interrupt-tolerant workloads.

## 12.4 Limitations / trade-offs

For the current project, AWS introduces the most architecture decisions:

- ECS configuration
- Fargate tasks
- Load balancer
- VPC/subnets/security groups
- IAM roles
- ECR registry
- CloudWatch
- Secrets
- Scaling policies

It is powerful, but the project does not currently require this additional operational surface.

## 12.5 Project suitability

**Excellent enterprise capability; low current cost-benefit for migration.** Consider it if the organization standardizes on AWS or future compliance/infrastructure requirements justify it.

---

# 13. Existing Database — Supabase

**Official:** https://supabase.com  
**Billing docs:** https://supabase.com/docs/guides/platform/billing-on-supabase  

Emlynk already uses Supabase PostgreSQL and Supavisor pooling. Hosting evaluation should not assume the database must move together with the web application.

### Why keeping Supabase is preferable now

- Existing Prisma/database schema already targets it.
- Migrations and data are already there.
- Supavisor provides a useful pooling layer for serverless/container clients.
- A DB migration introduces data-loss/downtime risk without a current requirement.
- Application hosting and database hosting can remain independent.

A future database migration should be justified by measured needs such as compliance, region, performance, cost, backup policy or enterprise support—not merely because a different application host is selected.

---

# 14. Direct Feature Comparison

| Area | Cloud Run | Vercel | Railway | Render | DO App Platform | Azure Container Apps | Fly.io | AWS Fargate |
|---|---|---|---|---|---|---|---|---|
| React/Vite frontend | Good | **Excellent** | Good | Excellent | Excellent | Possible | Good | Possible |
| Express API | **Excellent** | Good | **Excellent** | **Excellent** | **Excellent** | **Excellent** | Excellent | Excellent |
| Docker | **Excellent** | Not primary model | **Excellent** | Excellent | Excellent | **Excellent** | **Excellent** | **Excellent** |
| OCR/heavy compute | **Excellent** | Moderate | Very good | Very good | Good | Excellent | Very good | Excellent |
| Background workers | Excellent | Limited fit | Very good | **Excellent** | Good | Excellent/jobs | Very good | Excellent |
| Scale to zero | **Yes** | Function model | Usage/platform dependent | Free sleeps; paid model differs | Supported in some modes | **Yes** | Configurable | Architecture dependent |
| Git deployment ease | Good | **Excellent** | **Excellent** | **Excellent** | Excellent | Good | Moderate | Moderate |
| Preview workflow | Good with setup | **Excellent** | Good | Good | Good | Requires setup | More manual | Requires setup |
| Operational simplicity | Good | **Excellent** | **Excellent** | **Excellent** | Very good | Good | Moderate | Low/Moderate |
| Fixed-cost predictability | Moderate | Moderate | Moderate | Good | **Very good** | Moderate | Good | Moderate |
| Scale/burst efficiency | **Excellent** | Excellent | Very good | Good | Good | Excellent | Very good | Excellent |
| Current Emlynk usage | **Yes — OCR** | **Yes — Admin/app** | No | No | No | No | No | No |
| Migration effort | **Low** | **Low** | Medium | Medium | Medium | Medium/High | Medium/High | High |

---

# 15. Cost Model Comparison

An exact monthly total cannot be responsibly calculated without measured production-like traffic. The major variables are:

- Admin requests/day
- WhatsApp webhook messages/day
- Candidate registrations/day
- Documents/day
- Average upload size
- OCR jobs/month
- Average OCR CPU/RAM and duration
- API response duration
- Database storage and connections
- Outbound bandwidth
- Minimum warm instances
- Number of deployment team members

## 15.1 Cost characteristics

| Provider | Entry / base characteristic | Cost behavior |
|---|---|---|
| Vercel | Hobby $0; Pro $20/month | Frontend-friendly; Pro includes usage credit, additional compute/network usage can bill |
| Cloud Run | Usage based + free tier | Excellent for bursty services that can scale to zero |
| Railway | Free $0; Hobby $5; Pro $20 | Subscription counts toward metered CPU/RAM/storage/egress usage |
| Render | Free evaluation + paid compute | Paid services are easier to budget; free sleeping service unsuitable for production webhook |
| DigitalOcean App Platform | Shared containers from $5/month | Very predictable instance pricing; higher tiers for more resources/autoscaling |
| Azure Container Apps | Usage based + monthly free grant | Similar scale-to-zero economics to Cloud Run |
| Fly.io | Small Machines from a few dollars/month | Compute + storage + IP + egress components |
| AWS Fargate | Usage based | Flexible; architecture may add ALB/network/logging/etc. charges |

## 15.2 Illustrative workload scenarios

These are architecture scenarios, **not quoted bills**.

### Scenario 1 — Early production / low traffic

- Small Admin team
- Low daily WhatsApp traffic
- A few OCR jobs per day
- Long idle periods

**Best economic architecture:** Vercel frontend + Cloud Run OCR/API + Supabase.

Why: static delivery is cheap, Cloud Run can scale down, and there is no need to pay for a large continuously running VM.

### Scenario 2 — Moderate continuous traffic

- Admin users active through business hours
- Regular WhatsApp traffic
- Frequent uploads
- OCR throughout the day

**Best options:**

- Cloud Run with sensible concurrency and possibly a minimum API instance, or
- Railway Pro if the team values a simpler always-available service model.

### Scenario 3 — Heavy OCR bursts

- Many files arrive simultaneously
- OCR consumes significant CPU/RAM
- PDFs can take variable processing time

**Best architecture:** Cloud Run worker + queue/task architecture.

```text
Webhook / Upload
      |
      v
Main API -----> Queue / Task -----> OCR Worker(s)
      |                              |
      v                              v
Immediate acknowledgement      DB / Storage update
```

This is more important than changing hosting providers: the architecture should decouple user-facing requests from CPU-heavy OCR.

### Scenario 4 — Management wants the simplest backend platform

**Best alternative:** Railway.

It provides a conventional Node service with Docker/Git deployment and less cloud configuration than GCP/AWS.

### Scenario 5 — Management wants predictable fixed monthly container cost

**Best alternative:** DigitalOcean App Platform.

The fixed instance sizes make monthly compute easier to forecast, although it sacrifices some scale-to-zero efficiency.

---

# 16. Key Limitations That Matter Specifically to Emlynk

## Vercel

- Heavy OCR is not its strongest workload.
- Function/serverless execution is different from a permanent Node server.
- Persistent local filesystem should not be assumed.
- DB connection pooling remains important.

## Cloud Run

- Cold starts can occur when scaling from zero.
- Cloud IAM/billing/configuration is more complex than simple PaaS.
- Costs are usage-based and require monitoring.

## Railway

- Usage can grow with always-on CPU/RAM.
- Adds another provider to the stack.
- Less extensive native ecosystem than GCP/AWS/Azure.

## Render

- Free services sleep after 15 minutes and can take ~1 minute to wake.
- Free tier explicitly not recommended for production.
- Local filesystem is ephemeral.

## DigitalOcean App Platform

- No persistent App Platform volumes.
- Local filesystem limited and ephemeral.
- More advanced autoscaling can require more expensive compute.

## Azure Container Apps

- New ecosystem and operational learning for the team.
- No current technical need to replace working Cloud Run.

## Fly.io

- More infrastructure/networking knowledge.
- Multi-component pricing.
- More operational work than Railway/Render.

## AWS ECS/Fargate

- Highest infrastructure complexity in the shortlist.
- Additional AWS services are commonly needed around Fargate.
- Migration cost is difficult to justify at the current stage.

---

# 17. Weighted Decision Matrix for EmlynkWABot

Score: **1 = weak fit, 5 = excellent fit**.  
Weights reflect the current project's priorities.

| Criterion | Weight | Cloud Run | Vercel | Railway | Render | DO App Platform | Azure CA | Fly.io | AWS Fargate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Existing architecture fit | 5 | 5 | 5 | 3 | 3 | 3 | 2 | 2 | 2 |
| Node/Express API | 5 | 5 | 3 | 5 | 5 | 5 | 5 | 5 | 5 |
| OCR/container workload | 5 | 5 | 2 | 4 | 4 | 4 | 5 | 5 | 5 |
| Background processing | 4 | 5 | 2 | 4 | 5 | 4 | 5 | 4 | 5 |
| Deployment simplicity | 4 | 3 | 5 | 5 | 5 | 5 | 3 | 3 | 2 |
| Low-traffic cost efficiency | 4 | 5 | 4 | 4 | 3 | 3 | 5 | 4 | 3 |
| Cost predictability | 3 | 3 | 3 | 4 | 4 | 5 | 3 | 4 | 3 |
| Scaling | 4 | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 5 |
| Preview/staging workflow | 3 | 3 | 5 | 4 | 4 | 4 | 3 | 3 | 3 |
| Ecosystem/future expansion | 3 | 5 | 3 | 3 | 3 | 4 | 5 | 3 | 5 |
| Operational simplicity | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 3 | 2 |
| Migration risk | 5 | 5 | 5 | 3 | 3 | 3 | 2 | 2 | 2 |

### Interpretation

No single provider wins every category. The important result is that **Vercel and Cloud Run solve different parts of the problem extremely well**. Replacing one with the other across the entire stack would reduce that specialization.

Railway and Render are attractive because they reduce operational complexity for a conventional Express service, but they do not provide enough benefit to justify moving the already-working OCR service today.

---

# 18. Architecture Alternatives

## Alternative 1 — Recommended Hybrid

```text
Vercel
  └── Admin React/Vite frontend

Google Cloud Run
  ├── OCR Worker
  └── Express API (if/when container backend is preferred)

Supabase
  └── PostgreSQL + Supavisor
```

### Pros

- Reuses current infrastructure.
- Best workload placement.
- Excellent preview frontend.
- Strong OCR/container runtime.
- Low migration risk.
- Scale-to-zero available.
- Database stays unchanged.

### Cons

- Multiple provider dashboards.
- Environment variables must be coordinated.
- Observability spans more than one platform.

**Verdict: Best overall fit.**

---

## Alternative 2 — Vercel + Railway + Supabase

```text
Vercel -> frontend
Railway -> Express API / optional workers
Supabase -> database
Cloud Run -> keep OCR initially
```

### Pros

- Very simple backend developer experience.
- Easy Git deployments.
- Conventional Node service.

### Cons

- Adds Railway while Cloud Run remains for OCR.
- More vendors, not fewer, unless OCR is migrated too.
- Migration/testing effort.

**Verdict: Best simplicity-focused alternative for the main API.**

---

## Alternative 3 — Render + Supabase

```text
Render Static/Web -> frontend/API
Render Worker -> background jobs
Supabase -> database
```

### Pros

- Simple PaaS model.
- Worker support.
- Git deployment and health checks.

### Cons

- Production must use paid compute.
- Migration from existing working platforms.
- Less reason to move OCR away from Cloud Run.

**Verdict: Good all-PaaS alternative, but not superior enough to justify migration now.**

---

## Alternative 4 — DigitalOcean App Platform + Supabase

### Pros

- Predictable instance pricing.
- Easy Git/container deployments.
- Simple operational model.

### Cons

- Less efficient for highly bursty OCR.
- No App Platform persistent volumes.
- Migration work.

**Verdict: Good when predictable fixed cost is a priority.**

---

## Alternative 5 — Single Hyperscale Cloud

Use Google Cloud, Azure or AWS for frontend/backend/worker/storage/queue/database.

### Pros

- Centralized IAM/networking/billing.
- Strong enterprise capability.
- Deep cloud-native ecosystem.

### Cons

- Largest migration.
- Higher operational complexity.
- Current Supabase/Vercel advantages would be discarded.
- No evidence the project currently needs this consolidation.

**Verdict: Future option, not current recommendation.**

---

# 19. Why a Cheap VPS Is Not the First Recommendation

A $5–$20 VPS can look cheaper than managed platforms, but the sticker price excludes engineering responsibility.

With a VPS the team normally owns:

- OS security updates
- Firewall
- Reverse proxy
- TLS renewal/configuration
- Docker/runtime updates
- Process supervision
- Monitoring
- Disk capacity
- Backups
- Failover
- Scaling
- Incident recovery
- Server hardening

For a WhatsApp/document business system, operational reliability and security matter more than saving a few dollars of nominal compute cost.

A VPS becomes reasonable when the team deliberately wants infrastructure ownership and has operational capacity to maintain it.

---

# 20. Recommended Production Design

```text
                                  INTERNET
                                      |
                    +-----------------+------------------+
                    |                                    |
                    v                                    v
          +-------------------+                  +----------------+
          | Admin users       |                  | Meta WhatsApp  |
          +---------+---------+                  +-------+--------+
                    |                                    |
                    v                                    |
          +-------------------+                          |
          | Vercel            |                          |
          | React/Vite Admin  |                          |
          | CDN + TLS         |                          |
          +---------+---------+                          |
                    |                                    |
                    +----------------+-------------------+
                                     |
                                     v
                          +-----------------------+
                          | Express API           |
                          | Cloud Run / current   |
                          | backend environment   |
                          +----+-------------+----+
                               |             |
                    +----------+             +----------------+
                    |                                         |
                    v                                         v
             +-------------+                          +----------------+
             | Supabase    |                          | OCR Service    |
             | PostgreSQL  |                          | Cloud Run      |
             | Supavisor   |                          | Docker         |
             +-------------+                          +-------+--------+
                                                             |
                                                             v
                                                     OCR / PDF processing
```

### Future high-volume improvement

```text
API -> Queue/Task -> OCR Worker -> Database/Storage
```

This is recommended before trying to solve heavy OCR concurrency simply by buying a larger web server.

---

# 21. Staging and Production Strategy

## Staging

```text
feature branch -> dev -> stage -> Vercel Preview / staging services
```

Staging should test:

- Admin authentication
- RBAC
- Candidate registration
- WhatsApp webhook behavior where safe
- Database connectivity
- Uploads
- OCR integration
- Google Sheets sync
- Email/invitation URLs

## Production

Production should deploy only reviewed/approved code and use separate production secrets.

### Environment separation

At minimum review/separate:

- `DATABASE_URL`
- `DIRECT_URL`
- `JWT_SECRET`
- Meta/WhatsApp credentials
- Google credentials
- OCR service URL
- Admin setup URL
- Email credentials
- Storage credentials

Production secrets must never be committed into Git or the R&D branch.

---

# 22. Security Evaluation

The hosting choice does not replace application security. Whichever provider is selected, production should enforce:

1. HTTPS everywhere.
2. Secret/environment variable storage.
3. No committed `.env` files.
4. Least-privilege service accounts.
5. Backend RBAC enforcement.
6. Webhook verification.
7. Rate limiting.
8. File type and size validation.
9. Database pooling and SSL.
10. Strong JWT/session secrets.
11. Audit/error logs without leaking sensitive data.
12. Database/storage backup strategy.
13. Billing alerts and spend controls.
14. Health checks.
15. Dependency/security update process.
16. Separate staging and production credentials where practical.

---

# 23. Reliability and Failure Analysis

| Failure/Risk | Likely effect | Recommended mitigation |
|---|---|---|
| Cloud Run cold start | First request slower | Measure first; use minimum instance only if required |
| OCR spike | CPU/memory pressure | Separate worker + concurrency limits + queue |
| DB connection exhaustion | 5xx/API failures | Supavisor/pooling + connection monitoring |
| Very large upload | Timeout/memory pressure | File-size limits and direct durable-storage upload pattern |
| Vercel runtime mismatch | Backend task failure | Keep heavy/long work in Cloud Run |
| Render free sleep | Webhook delay/failure risk | Never use free sleeping service for production webhook |
| Railway usage growth | Unexpected bill | Usage alerts/limits and resource monitoring |
| Multi-provider outage | Partial system outage | Retries, queues, backups, documented recovery |
| Secret leak | Security incident | Secret manager/env vars + immediate rotation process |
| OCR worker unavailable | Documents delayed | Retry/backoff and processing status rather than losing submission |

---

# 24. Migration Effort Comparison

| Choice | Estimated engineering effort | Reason |
|---|---|---|
| Keep Vercel + Cloud Run + Supabase | **Low** | Already used; mainly production hardening |
| Add/move API to Cloud Run | Low–Medium | Docker/deploy config and endpoint regression testing |
| Move API to Railway | Medium | New service, envs, domains, webhook/API URL changes, testing |
| Move to Render | Medium | Similar migration plus service/worker configuration |
| Move to DigitalOcean App Platform | Medium | New deployment model and regression testing |
| Move to Azure Container Apps | Medium–High | New cloud identity/registry/monitoring ecosystem |
| Move to Fly.io | Medium–High | New networking/machine operational model |
| Move to AWS ECS/Fargate | **High** | IAM, networking, ALB/ECS/ECR/logging/scaling architecture |

---

# 25. Final Ranking by Scenario

Rather than claiming one universal winner, the most useful conclusion is scenario-specific.

| Scenario | Most suitable choice | Reason |
|---|---|---|
| Admin frontend | **Vercel** | CDN + Git previews + minimal operations |
| Existing OCR worker | **Google Cloud Run** | Already working, container-native, scale-to-zero |
| Future containerized Express API | **Google Cloud Run** | Same cloud/runtime model as OCR and strong scaling |
| Simplest Express PaaS alternative | **Railway** | Excellent Node/Git developer experience |
| Simple web + worker PaaS alternative | **Render** | Web services + background workers |
| Predictable fixed-size container bill | **DigitalOcean App Platform** | Clear monthly instance sizes |
| Microsoft-standard organization | **Azure Container Apps** | Strong serverless container model |
| Fine-grained global microVM control | **Fly.io** | Regional Machines and container control |
| AWS-standard enterprise | **ECS/Fargate** | Deep AWS ecosystem and enterprise controls |

---

# 26. Final Recommendation to Management

## Recommended now

**Do not migrate the entire application to a new provider. Formalize the existing hybrid architecture.**

### Use Vercel for

- React/Vite Admin Panel
- Static assets/CDN
- Preview/stage deployments
- Custom domain/TLS
- Lightweight web functions only where appropriate

### Use Google Cloud Run for

- OCR worker
- CPU/memory-intensive document processing
- Future background/container services
- Main Express API if a dedicated container runtime becomes preferable to Vercel's serverless model

### Keep Supabase for

- PostgreSQL
- Existing schema/data
- Supavisor connection pooling

## Why this is the most suitable architecture

1. **Lowest migration risk** — all three technologies are already part of the project.
2. **Correct workload separation** — frontend, database and OCR do not compete for one server.
3. **Good low-traffic economics** — Cloud Run can scale down instead of paying for an oversized 24/7 VM.
4. **Strong development workflow** — Vercel previews work well with the stage branch.
5. **Strong OCR runtime** — Docker/container compute is the correct environment for Tesseract/PDF work.
6. **Scalable future architecture** — queues and additional workers can be introduced without redesigning the Admin frontend.
7. **No unnecessary database migration** — Supabase remains stable.
8. **Reduced operations burden** — no raw server maintenance.

## When to reconsider

Re-run this hosting decision if one or more of the following becomes true:

- Cloud Run bill becomes materially higher than an always-on alternative.
- The API requires persistent connections or behavior incompatible with the current runtime.
- OCR throughput exceeds the current worker architecture.
- Compliance requires a specific cloud/provider/region.
- The company standardizes on AWS/Azure/GCP.
- Supabase becomes a performance/compliance/cost bottleneck.
- A single-provider contract becomes an organizational requirement.

---

# 27. Recommended Next R&D Measurements

Before approving a long-term production budget, collect staging measurements for at least:

- Average and peak API requests/minute
- WhatsApp webhook events/day
- Candidate registrations/day
- Documents/day
- Average and maximum document size
- OCR jobs/day
- Average OCR duration
- OCR p95 duration
- OCR CPU/RAM configuration
- Database connections under peak load
- Monthly outbound bandwidth
- Build/deployment frequency

Then run the measured numbers through official pricing calculators. This produces a defensible budget instead of guessing from plan names.

---

# 28. Branch / Documentation Recommendation

The senior requested this R&D to remain isolated. Create a dedicated documentation branch containing only this Markdown document.

Suggested branch name:

```bash
git switch --orphan rnd/hosting-services
```

An orphan branch is appropriate **only if the explicit requirement is that the branch must contain only this MD file and no project history/files in its working tree snapshot**. Carefully remove tracked files from the orphan branch before adding this document; do not delete them from `dev`, `stage`, or `main`.

Suggested filename:

```text
HOSTING_SERVICES_RND.md
```

Suggested commit:

```text
docs(rnd): add hosting services analysis and recommendation
```

> If the senior only means “do not mix implementation changes into this branch,” a normal branch from `dev` with only this MD as the new change is safer and preserves project history. Confirm which interpretation is intended before using an orphan branch.

---

# 29. Official Sources

Research checked on **07 October 2026**. Use these official sources for final purchasing decisions.

## Google Cloud Run

- Product: https://cloud.google.com/run
- Pricing: https://cloud.google.com/run/pricing
- Quotas/limits: https://cloud.google.com/run/quotas

## Vercel

- Product: https://vercel.com
- Pricing: https://vercel.com/pricing
- Limits: https://vercel.com/docs/limits
- Functions documentation: https://vercel.com/docs/functions

## Railway

- Product/pricing: https://railway.com/pricing
- Pricing documentation: https://docs.railway.com/pricing
- Plan documentation: https://docs.railway.com/pricing/plans

## Render

- Product: https://render.com
- Pricing: https://render.com/pricing
- Free tier limitations: https://render.com/docs/free
- Web services: https://render.com/docs/web-services

## DigitalOcean App Platform

- Product: https://www.digitalocean.com/products/app-platform
- Pricing: https://docs.digitalocean.com/products/app-platform/details/pricing/
- Limits: https://docs.digitalocean.com/products/app-platform/details/limits/

## Azure Container Apps

- Product: https://azure.microsoft.com/products/container-apps/
- Pricing: https://azure.microsoft.com/pricing/details/container-apps/

## Fly.io

- Product: https://fly.io
- Pricing: https://fly.io/pricing
- October 2026 pricing update: https://fly.io/pricing-update/

## AWS

- ECS: https://aws.amazon.com/ecs/
- Fargate pricing: https://aws.amazon.com/fargate/pricing/
- App Runner availability change: https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
- AWS Pricing Calculator: https://calculator.aws/

## Supabase

- Product: https://supabase.com
- Billing documentation: https://supabase.com/docs/guides/platform/billing-on-supabase

---

# 30. Conclusion

The R&D does **not** support moving EmlynkWABot wholesale to a different host merely to use one provider.

The project's workloads are different enough that a hybrid design is technically justified:

- **Vercel** is highly suitable for the Admin frontend and staging/preview experience.
- **Google Cloud Run** is highly suitable for the existing OCR worker and other containerized compute.
- **Supabase** already satisfies the PostgreSQL requirement and should remain unless a specific database problem appears.
- **Railway** is the strongest alternative if backend operational simplicity becomes the main priority.
- **Render** is another good managed PaaS, but its free tier is not appropriate for a production webhook.
- **DigitalOcean App Platform** is useful when predictable fixed-size pricing is prioritized.
- **Azure Container Apps** is a technically strong Cloud Run alternative if the organization moves toward Azure.
- **Fly.io** provides useful infrastructure control but adds operational complexity.
- **AWS ECS/Fargate** offers the broadest enterprise infrastructure path but is currently more complex than the project requires.

**Final decision recommendation:** Continue with and production-harden the **Vercel + Google Cloud Run + Supabase** architecture, measure real staging usage, and only migrate a component when measured cost, reliability, compliance, or runtime requirements justify the change.
