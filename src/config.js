// Runtime configuration, all from environment variables.
// No secret has a default value; the HMAC secret must come from the
// Agent Games dashboard ("Rotate Secret") via AGENT_GAMES_HMAC_SECRET.
const fs = require("fs");
const path = require("path");

const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

function defaultCircuitsDir() {
  const candidates = [
    path.resolve(__dirname, "..", "circuits"),
    path.resolve(process.cwd(), "circuits"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "gatekeeper.wasm"))) return c;
  }
  return candidates[0];
}

function defaultSeenStorePath() {
  // Vercel serverless filesystems are read-only except /tmp.
  if (process.env.VERCEL) return "/tmp/gatekeeper-seen.json";
  return path.resolve(process.cwd(), "data", "seen.json");
}

function loadConfig(env = process.env) {
  return {
    hmacSecret: env.AGENT_GAMES_HMAC_SECRET ?? "",
    kurierApiKey: env.KURIER_API_KEY ? env.KURIER_API_KEY : null,
    kurierApiUrl: env.KURIER_API_URL ?? "https://api.kurier.xyz/api/v1",
    // Registered gatekeeper vk_hash on zkVerify mainnet (from /build, /api/circuit-info).
    gatekeeperVkHash: env.GATEKEEPER_VK_HASH ?? GATEKEEPER_VK_HASH,
    circuitsDir: env.CIRCUITS_DIR ?? defaultCircuitsDir(),
    seenStorePath: env.SEEN_STORE_PATH ?? defaultSeenStorePath(),
    // Optional durable seen-set for serverless: Upstash Redis REST credentials.
    // When set, Redis is the primary store; the JSON file remains as fallback.
    upstashUrl: env.UPSTASH_REDIS_REST_URL ?? "",
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN ?? "",
    // Stop polling Kurier after this long; the response must stay well under the 60s deadline.
    kurierPollBudgetMs: Number(env.KURIER_POLL_BUDGET_MS ?? 8000),
    kurierPollIntervalMs: Number(env.KURIER_POLL_INTERVAL_MS ?? 2000),
    // Soft internal deadline for the whole task handler.
    taskSoftDeadlineMs: Number(env.TASK_SOFT_DEADLINE_MS ?? 50000),
    port: Number(env.PORT ?? 8787),
  };
}

module.exports = { loadConfig, GATEKEEPER_VK_HASH };
