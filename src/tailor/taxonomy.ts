/**
 * A small skill taxonomy: canonical names, aliases, categories, and explicit
 * neighbours. It drives three deterministic steps that must not depend on an
 * LLM's mood: matching a job description's requirements to the stories a
 * user actually has, finding the *nearest adjacent* evidence for a gap
 * ("no Kafka, but RabbitMQ and Redis Streams"), and profiling which skills the
 * ledger demonstrates for the contribution scout. Unknown skills still work
 * by exact-name match; the taxonomy only adds aliases and adjacency.
 */
export type SkillCategory =
  | "language" | "frontend" | "backend" | "database" | "cache" | "messaging" | "data"
  | "ml" | "ai" | "cloud" | "container" | "iac" | "cicd" | "observability" | "security" | "api" | "testing" | "mobile";

export interface Skill {
  name: string;
  category: SkillCategory;
  aliases?: string[];
  /** Closest neighbours — what a hiring manager would accept as transferable. */
  related?: string[];
}

export const SKILLS: Skill[] = [
  // languages
  { name: "TypeScript", category: "language", aliases: ["ts"], related: ["JavaScript"] },
  { name: "JavaScript", category: "language", aliases: ["js", "ecmascript"], related: ["TypeScript"] },
  { name: "Python", category: "language", aliases: ["py"] },
  { name: "Go", category: "language", aliases: ["golang"] },
  { name: "Java", category: "language", related: ["Kotlin", "Scala", "C#"] },
  { name: "Kotlin", category: "language", related: ["Java"] },
  { name: "Scala", category: "language", related: ["Java"] },
  { name: "Rust", category: "language", related: ["C++", "Go"] },
  { name: "C#", category: "language", aliases: ["csharp", ".net", "dotnet"], related: ["Java"] },
  { name: "C++", category: "language", aliases: ["cpp"], related: ["Rust"] },
  { name: "Ruby", category: "language", related: ["Python"] },
  { name: "PHP", category: "language" },
  { name: "Swift", category: "language", related: ["Kotlin"] },
  { name: "SQL", category: "database" },
  // frontend
  { name: "React", category: "frontend", aliases: ["react.js", "reactjs"], related: ["Next.js", "Vue", "Svelte"] },
  { name: "Next.js", category: "frontend", aliases: ["nextjs"], related: ["React"] },
  { name: "Vue", category: "frontend", aliases: ["vue.js", "vuejs"], related: ["React", "Svelte"] },
  { name: "Angular", category: "frontend", related: ["React"] },
  { name: "Svelte", category: "frontend", related: ["Vue", "React"] },
  // backend frameworks
  { name: "Node.js", category: "backend", aliases: ["node", "nodejs"], related: ["Express", "Deno"] },
  { name: "Express", category: "backend", aliases: ["express.js", "expressjs"], related: ["Fastify", "NestJS", "Node.js"] },
  { name: "Fastify", category: "backend", related: ["Express"] },
  { name: "NestJS", category: "backend", related: ["Express"] },
  { name: "Django", category: "backend", related: ["Flask", "FastAPI"] },
  { name: "Flask", category: "backend", related: ["FastAPI", "Django"] },
  { name: "FastAPI", category: "backend", related: ["Flask", "Django"] },
  { name: "Spring Boot", category: "backend", aliases: ["spring"], related: ["Java"] },
  { name: "Ruby on Rails", category: "backend", aliases: ["rails"], related: ["Django"] },
  { name: "ASP.NET Core", category: "backend", aliases: ["asp.net"], related: ["C#"] },
  // databases & caches
  { name: "PostgreSQL", category: "database", aliases: ["postgres", "psql"], related: ["MySQL", "SQL"] },
  { name: "MySQL", category: "database", aliases: ["mariadb"], related: ["PostgreSQL"] },
  { name: "MongoDB", category: "database", aliases: ["mongo"], related: ["DynamoDB"] },
  { name: "DynamoDB", category: "database", related: ["Cassandra", "MongoDB"] },
  { name: "Cassandra", category: "database", related: ["DynamoDB"] },
  { name: "Elasticsearch", category: "database", aliases: ["elastic", "opensearch"] },
  { name: "Redis", category: "cache", related: ["Memcached", "Redis Streams"] },
  { name: "Memcached", category: "cache", related: ["Redis"] },
  // messaging & streaming
  { name: "Kafka", category: "messaging", aliases: ["apache kafka"], related: ["Kinesis", "Pulsar", "RabbitMQ", "Redis Streams"] },
  { name: "RabbitMQ", category: "messaging", related: ["Kafka", "SQS", "NATS"] },
  { name: "SQS", category: "messaging", aliases: ["amazon sqs"], related: ["RabbitMQ", "Kafka"] },
  { name: "Kinesis", category: "messaging", related: ["Kafka"] },
  { name: "Pulsar", category: "messaging", related: ["Kafka"] },
  { name: "NATS", category: "messaging", related: ["RabbitMQ"] },
  { name: "Redis Streams", category: "messaging", related: ["Kafka", "Redis"] },
  { name: "Event-driven architecture", category: "messaging", aliases: ["event driven", "pub/sub", "pubsub"], related: ["Kafka", "RabbitMQ"] },
  // data
  { name: "Apache Spark", category: "data", aliases: ["spark", "pyspark"], related: ["Flink", "Dask", "Beam"] },
  { name: "Flink", category: "data", related: ["Apache Spark", "Kafka"] },
  { name: "Airflow", category: "data", related: ["Dagster", "Prefect"] },
  { name: "dbt", category: "data", related: ["SQL"] },
  { name: "pandas", category: "data", related: ["Apache Spark", "Polars"] },
  { name: "Feature store", category: "ml", aliases: ["feast"], related: ["Apache Spark"] },
  // ml
  { name: "PyTorch", category: "ml", aliases: ["torch"], related: ["TensorFlow", "JAX"] },
  { name: "TensorFlow", category: "ml", related: ["PyTorch"] },
  // Short forms match case-sensitively, so the alias is "LLM" as people write it.
  { name: "LLMs", category: "ml", aliases: ["LLM", "large language models", "generative ai", "genai"], related: ["RAG"] },
  { name: "RAG", category: "ml", aliases: ["retrieval augmented generation", "retrieval-augmented generation"], related: ["LLMs", "Vector databases"] },
  // ai engineering
  { name: "AI agents", category: "ai", aliases: ["llm agents", "ai agent", "agentic ai", "agentic", "coding agents", "coding agent", "coding-agent", "autonomous agents"], related: ["Tool use", "Multi-agent orchestration", "Agent memory"] },
  { name: "Tool use", category: "ai", aliases: ["tool calling", "tool-calling", "function calling", "tool-use", "tool-using", "tool loop", "tool calls"], related: ["AI agents", "MCP"] },
  { name: "Multi-agent orchestration", category: "ai", aliases: ["multi-agent", "multi agent", "subagent", "subagents", "agent orchestration"], related: ["AI agents", "Tool use"] },
  { name: "Agent memory", category: "ai", aliases: ["long-term memory", "memory tiers", "episodic memory"], related: ["Context engineering", "RAG"] },
  { name: "Context engineering", category: "ai", aliases: ["context window", "context management", "compaction", "repo map", "prompt engineering"], related: ["Agent memory", "RAG"] },
  { name: "LLM evaluation", category: "ai", aliases: ["llm evals", "evals", "llm-as-judge", "llm as a judge", "llm as judge", "eval suite", "eval harness", "prompt eval", "prompt evaluation"], related: ["AI safety"] },
  { name: "Prompt injection defense", category: "ai", aliases: ["prompt injection", "prompt-injection", "prompt injection defenses", "dual-llm pattern", "dual llm pattern", "dual-llm"], related: ["AI safety"] },
  { name: "AI safety", category: "ai", aliases: ["llm safety", "guardrails", "red teaming", "red-team", "responsible ai"], related: ["Prompt injection defense", "LLM evaluation"] },
  { name: "MCP", category: "ai", aliases: ["model context protocol", "mcp server", "mcp servers"], related: ["Tool use"] },
  { name: "Vector databases", category: "ai", aliases: ["vector database", "vector db", "vector store", "vector search", "embeddings", "pgvector", "pinecone", "weaviate", "qdrant", "chroma"], related: ["RAG"] },
  { name: "LangGraph", category: "ai", related: ["LangChain", "AI agents"] },
  { name: "LangChain", category: "ai", related: ["LangGraph", "LlamaIndex"] },
  { name: "LlamaIndex", category: "ai", related: ["LangChain", "RAG"] },
  { name: "Fine-tuning", category: "ai", aliases: ["fine tuning", "finetuning", "lora", "rlhf"], related: ["PyTorch", "LLMs"] },
  // cloud / containers / iac / cicd
  { name: "AWS", category: "cloud", aliases: ["amazon web services"], related: ["GCP", "Azure"] },
  { name: "GCP", category: "cloud", aliases: ["google cloud"], related: ["AWS", "Azure"] },
  { name: "Azure", category: "cloud", related: ["AWS", "GCP"] },
  { name: "Docker", category: "container", related: ["Kubernetes"] },
  { name: "Kubernetes", category: "container", aliases: ["k8s"], related: ["Docker", "ECS", "Helm", "Nomad"] },
  { name: "Helm", category: "container", related: ["Kubernetes"] },
  { name: "ECS", category: "container", related: ["Kubernetes"] },
  { name: "Terraform", category: "iac", related: ["Pulumi", "CloudFormation"] },
  { name: "Pulumi", category: "iac", related: ["Terraform"] },
  { name: "CloudFormation", category: "iac", aliases: ["cdk"], related: ["Terraform"] },
  { name: "GitHub Actions", category: "cicd", related: ["CI/CD"] },
  { name: "CI/CD", category: "cicd", aliases: ["continuous integration", "continuous delivery"], related: ["GitHub Actions"] },
  // observability / security / api / testing
  { name: "Prometheus", category: "observability", related: ["Grafana", "OpenTelemetry"] },
  { name: "Grafana", category: "observability", related: ["Prometheus"] },
  { name: "OpenTelemetry", category: "observability", aliases: ["otel"], related: ["Prometheus"] },
  { name: "OAuth", category: "security", aliases: ["oauth2", "oidc", "openid connect"], related: ["JWT"] },
  { name: "JWT", category: "security", aliases: ["json web token"], related: ["OAuth"] },
  { name: "GraphQL", category: "api", related: ["REST", "gRPC"] },
  { name: "REST", category: "api", aliases: ["rest api", "restful"], related: ["GraphQL", "gRPC"] },
  { name: "gRPC", category: "api", aliases: ["protobuf"], related: ["REST"] },
  { name: "Distributed systems", category: "backend", aliases: ["distributed computing"], related: ["Event-driven architecture"] },
  { name: "Rate limiting", category: "backend", aliases: ["rate limiter", "throttling"], related: ["Distributed systems", "Redis"] },
  { name: "Microservices", category: "backend", aliases: ["microservice", "service-oriented"], related: ["Distributed systems"] },
  { name: "Vitest", category: "testing", related: ["Jest"] },
  { name: "Jest", category: "testing", related: ["Vitest"] },
  { name: "pytest", category: "testing" },
  { name: "Playwright", category: "testing", related: ["Cypress"] },
  { name: "React Native", category: "mobile", related: ["React", "Flutter"] },
  { name: "Flutter", category: "mobile", related: ["React Native"] },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const BY_KEY = new Map<string, Skill>();
for (const skill of SKILLS) {
  BY_KEY.set(norm(skill.name), skill);
  for (const a of skill.aliases ?? []) BY_KEY.set(norm(a), skill);
}

/** Canonical skill for a name or alias, if the taxonomy knows it. */
export function lookupSkill(name: string): Skill | undefined {
  return BY_KEY.get(norm(name));
}

export function canonicalName(name: string): string {
  return lookupSkill(name)?.name ?? name.trim();
}

/**
 * A job requirement as the skills it names: an exact name or alias, else the
 * known skills inside the phrase ("Model Context Protocol (MCP)" → MCP,
 * "agent memory and context engineering" → Agent memory, Context engineering).
 * A phrase naming no known skill stays as written.
 */
export function canonicalRequirements(phrase: string): string[] {
  const exact = lookupSkill(phrase);
  if (exact) return [exact.name];
  const inside = skillsIn(phrase);
  return inside.length ? inside : [phrase.trim()];
}

/** Every surface form that should count as a mention of `skill`. */
export function surfaceForms(name: string): string[] {
  const s = lookupSkill(name);
  return s ? [s.name, ...(s.aliases ?? [])] : [name];
}

/**
 * Does `text` mention the skill (word-boundary, alias-aware)? Short or
 * all-caps forms ("Go", "REST", "SQL", "AWS") match case-sensitively so that
 * "let's go with" or "the rest of" don't count; everything else ignores case.
 */
export function mentions(text: string, name: string): boolean {
  return surfaceForms(name).some((f) => {
    const exact = f.length <= 3 || (/[A-Z]/.test(f) && f === f.toUpperCase());
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The second lookbehind keeps "js" from matching inside "Node.js".
    const re = new RegExp(`(?<![A-Za-z0-9+#])(?<![A-Za-z0-9]\\.)${escaped}($|[^A-Za-z0-9+#])`, exact ? "" : "i");
    return re.test(text);
  });
}

/** Known skills mentioned anywhere in `text`, canonicalized. */
export function skillsIn(text: string): string[] {
  return SKILLS.filter((s) => mentions(text, s.name)).map((s) => s.name);
}

/**
 * Neighbours of a skill, nearest first: explicit `related`, then skills that
 * list it as related, then the rest of its category.
 */
export function adjacentSkills(name: string): string[] {
  const skill = lookupSkill(name);
  if (!skill) return [];
  const explicit = skill.related ?? [];
  const reverse = SKILLS.filter((s) => s.related?.includes(skill.name)).map((s) => s.name);
  const category = SKILLS.filter((s) => s.category === skill.category).map((s) => s.name);
  return [...new Set([...explicit, ...reverse, ...category])].filter((n) => n !== skill.name);
}
