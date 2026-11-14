// Seen-set for proof_tx references ("The proof reference has not already been
// used for another task" — /build Security checklist; PROOF_REUSED trap).
//
// Two backends, chosen at startup:
//  1. Upstash Redis (REST) — used when UPSTASH_REDIS_REST_URL and
//     UPSTASH_REDIS_REST_TOKEN are set. This is the durable option for
//     serverless (Vercel): the seen-set survives cold starts and is shared
//     across instances. Create it in the Vercel dashboard (Storage -> Create
//     -> Upstash Redis, free tier) and the env vars are injected automatically.
//  2. JSON file — default. In-memory Set is authoritative for the life of the
//     process; a JSON file backs it across restarts (best-effort: on
//     serverless the file lives in /tmp and may vanish on cold start — for
//     maximum PROOF_REUSED reliability across the 8 rounds, either enable the
//     Redis backend or run on a single long-lived instance instead of
//     serverless).
//
// Also keeps a task_id -> serialized response cache so a redelivered task is
// answered idempotently instead of being misread as proof reuse.
//
// Storage failures are best-effort (logged, never fatal): the policy itself
// always fails closed, but a storage outage must not turn valid tasks into
// rejections. If Redis is configured and a call fails, the file backend is
// consulted as fallback.
const fs = require("fs");
const path = require("path");

function normalizeTx(tx) {
  return (tx ?? "").trim().toLowerCase();
}

class SeenStore {
  constructor(filePath, upstash) {
    this.filePath = filePath;
    this.upstash = upstash && upstash.url && upstash.token ? upstash : null;
    this.seenProofTx = new Set();
    this.responseByTaskId = new Map();
    this.loadFile();
  }

  // ---- Upstash Redis REST helpers (no SDK needed) ----
  async redisCall(pathParts, method = "GET") {
    const url = `${this.upstash.url}/${pathParts.map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.upstash.token}` },
    });
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
    return res.json();
  }

  async redisHasProofTx(tx) {
    const r = await this.redisCall(["SISMEMBER", "gk:seen:proofTx", normalizeTx(tx)]);
    return r.result === 1;
  }

  async redisRecordProofTx(tx) {
    await this.redisCall(["SADD", "gk:seen:proofTx", normalizeTx(tx)], "POST");
  }

  async redisGetResponse(taskId) {
    const r = await this.redisCall(["GET", `gk:resp:${taskId}`]);
    return typeof r.result === "string" ? r.result : null;
  }

  async redisRecordResponse(taskId, body) {
    // 7-day TTL: the tournament ends 21 Nov 2026; a week covers every redelivery window.
    await this.redisCall(["SET", `gk:resp:${taskId}`, body, "EX", "604800"], "POST");
  }

  // ---- JSON file backend ----
  loadFile() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      for (const tx of data.proofTx ?? []) this.seenProofTx.add(normalizeTx(tx));
      for (const [k, v] of Object.entries(data.responses ?? {})) {
        this.responseByTaskId.set(k, v);
      }
    } catch {
      /* missing/corrupt file -> start empty */
    }
  }

  persistFile() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          proofTx: [...this.seenProofTx],
          responses: Object.fromEntries(this.responseByTaskId),
        }),
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[seen-store] persist failed:", err.message);
    }
  }

  // ---- Public API (async: Redis may be involved) ----
  async hasProofTx(proofTx) {
    if (this.upstash) {
      try {
        if (await this.redisHasProofTx(proofTx)) return true;
      } catch (err) {
        console.error("[seen-store] redis check failed, falling back to file:", err.message);
      }
    }
    return this.seenProofTx.has(normalizeTx(proofTx));
  }

  async recordProofTx(proofTx) {
    const key = normalizeTx(proofTx);
    if (!key) return;
    if (this.upstash) {
      try {
        await this.redisRecordProofTx(key);
      } catch (err) {
        console.error("[seen-store] redis record failed:", err.message);
      }
    }
    if (!this.seenProofTx.has(key)) {
      this.seenProofTx.add(key);
      this.persistFile();
    }
  }

  async getResponse(taskId) {
    if (this.upstash) {
      try {
        const cached = await this.redisGetResponse(taskId);
        if (cached) return cached;
      } catch (err) {
        console.error("[seen-store] redis response lookup failed:", err.message);
      }
    }
    return this.responseByTaskId.get(taskId) ?? null;
  }

  async recordResponse(taskId, serializedResponse) {
    if (this.upstash) {
      try {
        await this.redisRecordResponse(taskId, serializedResponse);
      } catch (err) {
        console.error("[seen-store] redis response record failed:", err.message);
      }
    }
    if (!this.responseByTaskId.has(taskId)) {
      this.responseByTaskId.set(taskId, serializedResponse);
      this.persistFile();
    }
  }

  get size() {
    return this.seenProofTx.size;
  }
}

module.exports = { SeenStore, normalizeTx };
