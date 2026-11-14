// Local end-to-end harness: boots the real server and replays spec-shaped
// envelopes (valid task, all six trap classes, HMAC failures, preflight,
// idempotent redelivery, boundaries). Every returned proof is verified
// locally with snarkjs groth16.verify against the extracted verification key.
//
// Run: npm test        (uses a TEST secret only; never the platform secret)
// Exit code 0 = all checks pass.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const snarkjs = require("snarkjs");
const { toFieldElement } = require("../src/decision");

const TEST_SECRET = "harness-test-secret-only-not-a-real-secret";
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const RECIPIENT = "0xDe42000000000000000000000000000000009f01";
const OTHER = "0x1111111111111111111111111111111111111111";

const vk = require("../circuits/verification_key.json");
const results = [];
let passCount = 0;
let failCount = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) passCount++;
  else failCount++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

function sign(rawBody) {
  return crypto.createHmac("sha256", TEST_SECRET).update(rawBody).digest("hex");
}

function verifyResponseSignature(body, sig) {
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function baseInput(over = {}) {
  return {
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: RECIPIENT,
    condition_recipient: RECIPIENT,
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  };
}

function envelope(taskId, input, over = {}) {
  const now = new Date();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date(now.getTime() - 1000).toISOString(),
    deadline_at: new Date(now.getTime() + 55000).toISOString(),
    input,
    ...over,
  };
}

async function post(pathname, obj, secret = TEST_SECRET, rawOverride) {
  const raw = rawOverride !== undefined ? rawOverride : JSON.stringify(obj);
  const sig = secret === null ? null : crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const headers = { "content-type": "application/json" };
  if (sig) headers["x-agent-games-signature"] = sig;
  const t0 = Date.now();
  const res = await fetch(`${BASE}${pathname}`, { method: "POST", headers, body: raw });
  const body = await res.text();
  return { status: res.status, body, ms: Date.now() - t0, sig: res.headers.get("x-agent-games-signature") };
}

async function verifyProof(body, label) {
  if (!body.proof || !body.public_signals) return { ok: false, detail: "no proof in response" };
  if (body.public_signals.length !== 13) {
    return { ok: false, detail: `expected 13 public signals, got ${body.public_signals.length}` };
  }
  const t0 = Date.now();
  const valid = await snarkjs.groth16.verify(vk, body.public_signals, body.proof);
  if (!valid) return { ok: false, detail: "snarkjs verify returned false" };
  return { ok: true, detail: `verified in ${Date.now() - t0}ms` };
}

function checkSignalPositions(body, task) {
  const input = task.input;
  const expected = [
    null, // [0] commitment = Poseidon(taskId, salt), not directly computable here
    toFieldElement(input.registered_vk),
    toFieldElement(input.proof_vk),
    input.minimum,
    input.public_balance,
    String(input.expiry_block),
    String(input.current_block),
    toFieldElement(input.recipient),
    toFieldElement(input.condition_recipient),
    input.amount,
    input.max_transfer,
    body.decision === "APPROVE" ? "1" : "0",
    toFieldElement(task.task_id),
  ];
  const sig = body.public_signals;
  const mismatches = [];
  for (let i = 1; i <= 12; i++) {
    if (sig[i] !== expected[i]) mismatches.push(`[${i}] got ${sig[i]} want ${expected[i]}`);
  }
  return mismatches;
}

async function main() {
  const seenPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gk-test-")), "seen.json");
  const env = {
    ...process.env,
    PORT: String(PORT),
    AGENT_GAMES_HMAC_SECRET: TEST_SECRET,
    SEEN_STORE_PATH: seenPath,
    CIRCUITS_DIR: path.resolve(__dirname, "..", "circuits"),
  };
  delete env.KURIER_API_KEY; // harness never submits to Kurier
  const child = spawn("node", [path.resolve(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let childOut = "";
  child.stdout.on("data", (d) => { childOut += d; });
  child.stderr.on("data", (d) => { childOut += d; });

  // Wait for the listening line (max 15 s).
  const started = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    const iv = setInterval(() => {
      if (childOut.includes("listening on")) { clearTimeout(timer); clearInterval(iv); resolve(true); }
    }, 100);
  });
  if (!started) {
    console.error("server did not start in time:\n" + childOut);
    child.kill();
    process.exit(1);
  }

  try {
    // 1. Health check
    {
      const res = await fetch(`${BASE}/agent`);
      const body = await res.json();
      check("GET /agent health", res.status === 200 && body.ok === true && body.protocolVersion === "v1");
    }

    // 2. Preflight
    {
      const raw = JSON.stringify({ type: "agent-games.preflight.v1" });
      const res = await post("/agent", null, TEST_SECRET, raw);
      const body = JSON.parse(res.body);
      check(
        "preflight -> signed { ok: true, protocolVersion: v1 }",
        res.status === 200 && body.ok === true && body.protocolVersion === "v1" &&
          verifyResponseSignature(res.body, res.sig),
        `${res.ms}ms`,
      );
    }

    // 3. Valid task -> APPROVE + verified proof + signal positions
    let firstValidBody = null;
    {
      const task = envelope("gk_harness_valid_001", baseInput());
      const res = await post("/agent", task);
      const body = JSON.parse(res.body);
      firstValidBody = res.body;
      const sigOk = verifyResponseSignature(res.body, res.sig);
      const proofCheck = await verifyProof(body, "valid");
      const mismatches = body.public_signals ? checkSignalPositions(body, task) : ["no signals"];
      check(
        "valid task -> APPROVE / VALID_CONDITION",
        res.status === 200 && body.decision === "APPROVE" && body.reason_code === "VALID_CONDITION",
        `${res.ms}ms`,
      );
      check("valid task -> response signature verifies", sigOk);
      check("valid task -> Groth16 proof verifies locally", proofCheck.ok, proofCheck.detail);
      check(
        "valid task -> public signals match inputs (positions 1-12)",
        mismatches.length === 0,
        mismatches.join("; ") || "all 12 positions match",
      );
      check(
        "valid task -> proof_tx echoes input proof_tx (no Kurier key)",
        body.proof_tx === task.input.proof_tx,
      );
    }

    // 4-9. Six trap classes (each with a fresh proof_tx)
    const traps = [
      ["VK_SUBSTITUTION", baseInput({ proof_vk: "0x" + "22".repeat(32) }), "VK_SUBSTITUTION"],
      ["THRESHOLD_MISMATCH", baseInput({ public_balance: "999", proof_tx: "0x" + "bb".repeat(32) }), "THRESHOLD_MISMATCH"],
      ["EXPIRED_CONDITION", baseInput({ current_block: 8430000, proof_tx: "0x" + "cc".repeat(32) }), "EXPIRED_CONDITION"],
      ["RECIPIENT_MISMATCH", baseInput({ recipient: OTHER, proof_tx: "0x" + "dd".repeat(32) }), "RECIPIENT_MISMATCH"],
      ["AMOUNT_OVERFLOW", baseInput({ amount: "1001", proof_tx: "0x" + "ee".repeat(32) }), "AMOUNT_OVERFLOW"],
    ];
    for (const [name, input, wantCode] of traps) {
      const task = envelope(`gk_harness_${name.toLowerCase()}_001`, input);
      const res = await post("/agent", task);
      const body = JSON.parse(res.body);
      const proofCheck = await verifyProof(body, name);
      check(
        `trap ${name} -> REJECT / ${wantCode}`,
        res.status === 200 && body.decision === "REJECT" && body.reason_code === wantCode,
        `${res.ms}ms`,
      );
      check(`trap ${name} -> rejection proof verifies locally`, proofCheck.ok, proofCheck.detail);
    }

    // 10. PROOF_REUSED: new task_id, same proof_tx as the valid task
    {
      const task = envelope("gk_harness_reused_001", baseInput());
      const res = await post("/agent", task);
      const body = JSON.parse(res.body);
      check(
        "PROOF_REUSED -> REJECT / PROOF_REUSED, no proof field",
        res.status === 200 && body.decision === "REJECT" && body.reason_code === "PROOF_REUSED" &&
          !body.proof && !body.public_signals && body.proof_tx === task.input.proof_tx,
        `${res.ms}ms`,
      );
    }

    // 11. Idempotent redelivery: exact same valid task again -> identical body, not reuse
    {
      const task = envelope("gk_harness_valid_001", baseInput());
      const res = await post("/agent", task);
      check(
        "idempotent redelivery -> identical cached body (not reuse)",
        res.status === 200 && res.body === firstValidBody,
        `${res.ms}ms`,
      );
    }

    // 12-14. HMAC failures
    {
      const task = envelope("gk_harness_hmac_001", baseInput({ proof_tx: "0x" + "f1".repeat(32) }));
      const wrong = await post("/agent", task, "wrong-secret");
      check("wrong HMAC secret -> 401", wrong.status === 401);
      const missing = await post("/agent", task, null);
      check("missing signature -> 401", missing.status === 401);
      // Tampered body: sign body A, send body B.
      const rawA = JSON.stringify(envelope("gk_harness_hmac_002", baseInput({ proof_tx: "0x" + "f2".repeat(32) })));
      const rawB = JSON.stringify(envelope("gk_harness_hmac_002", baseInput({ public_balance: "1", proof_tx: "0x" + "f2".repeat(32) })));
      const sigA = sign(rawA);
      const res2 = await fetch(`${BASE}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-games-signature": sigA },
        body: rawB,
      });
      check("tampered body (sig for other body) -> 401", res2.status === 401);
    }

    // 15. Malformed JSON (signed) -> 400 REJECT / INVALID_TASK
    {
      const res = await post("/agent", null, TEST_SECRET, "{not json");
      const body = JSON.parse(res.body);
      check(
        "malformed JSON -> 400 REJECT / INVALID_TASK",
        res.status === 400 && body.decision === "REJECT" && body.reason_code === "INVALID_TASK",
      );
    }

    // 16. Past deadline -> REJECT / INVALID_TASK
    {
      const now = new Date();
      const task = envelope("gk_harness_deadline_001", baseInput({ proof_tx: "0x" + "f3".repeat(32) }), {
        deadline_at: new Date(now.getTime() - 1000).toISOString(),
      });
      const res = await post("/agent", task);
      const body = JSON.parse(res.body);
      check(
        "past deadline -> REJECT / INVALID_TASK",
        res.status === 200 && body.decision === "REJECT" && body.reason_code === "INVALID_TASK",
      );
    }

    // 17. Missing input field -> REJECT / INVALID_TASK
    {
      const input = baseInput({ proof_tx: "0x" + "f4".repeat(32) });
      delete input.amount;
      const task = envelope("gk_harness_missing_001", input);
      const res = await post("/agent", task);
      const body = JSON.parse(res.body);
      check(
        "missing input field -> REJECT / INVALID_TASK",
        res.status === 200 && body.decision === "REJECT" && body.reason_code === "INVALID_TASK",
      );
    }

    // 18. Boundaries
    {
      const t1 = envelope("gk_harness_bound_001", baseInput({ public_balance: "1000", proof_tx: "0x" + "f5".repeat(32) }));
      const r1 = await post("/agent", t1);
      check("boundary balance == minimum -> APPROVE", JSON.parse(r1.body).decision === "APPROVE");
      const t2 = envelope("gk_harness_bound_002", baseInput({ amount: "1000", proof_tx: "0x" + "f6".repeat(32) }));
      const r2 = await post("/agent", t2);
      check("boundary amount == max_transfer -> APPROVE", JSON.parse(r2.body).decision === "APPROVE");
      const t3 = envelope("gk_harness_bound_003", baseInput({ current_block: 8430000, proof_tx: "0x" + "f7".repeat(32) }));
      const r3 = await post("/agent", t3);
      const b3 = JSON.parse(r3.body);
      check(
        "boundary current_block == expiry_block -> REJECT / EXPIRED_CONDITION",
        b3.decision === "REJECT" && b3.reason_code === "EXPIRED_CONDITION",
      );
    }

    // 19. Unknown type -> 400 REJECT / INVALID_TASK
    {
      const res = await post("/agent", { type: "agent-games.something-else.v1" });
      const body = JSON.parse(res.body);
      check(
        "unknown envelope type -> 400 REJECT / INVALID_TASK",
        res.status === 400 && body.decision === "REJECT" && body.reason_code === "INVALID_TASK",
      );
    }
  } finally {
    child.kill();
  }

  // 20. Server without HMAC secret -> 500 (separate instance)
  {
    const env2 = { ...process.env, PORT: "18788", SEEN_STORE_PATH: path.join(os.tmpdir(), `gk-test-nosecret-${Date.now()}.json`) };
    delete env2.AGENT_GAMES_HMAC_SECRET;
    const child2 = spawn("node", [path.resolve(__dirname, "..", "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch("http://127.0.0.1:18788/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "agent-games.preflight.v1" }),
      });
      check("server without HMAC secret -> 500 server_misconfigured", res.status === 500);
    } catch (e) {
      check("server without HMAC secret -> 500 server_misconfigured", false, e.message);
    } finally {
      child2.kill();
    }
  }

  console.log(`\n${passCount} passed, ${failCount} failed (${results.length} checks)`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
