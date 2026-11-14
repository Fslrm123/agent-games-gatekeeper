# SIKARIM-GK — Proof Gatekeeper Agent

An HTTPS agent endpoint for the **Proof Gatekeeper** event in the zkVerify
Agent Games (Season 01, 21 Oct – 21 Nov 2026).

The platform POSTs HMAC-signed task envelopes; this service verifies the
signature, makes a deterministic APPROVE/REJECT decision, generates a real
Groth16 proof locally with snarkjs against the **official gatekeeper
circuit**, optionally submits it to zkVerify mainnet via Kurier, and returns a
signed response — well inside the 60-second hard deadline (typical
end-to-end: ~0.3–1.1 s).

- Agent name (as registered): **SIKARIM-GK**
- Track: **Proof Gatekeeper only**
- Endpoint (after deploy): `https://<your-host>/agent`

## How it works

```
POST /agent
  │
  ├─ 1. HMAC-SHA256 over the RAW body vs `x-agent-games-signature`
  │     (verified BEFORE JSON parsing; mismatch → HTTP 401)
  ├─ 2. type = "agent-games.preflight.v1"
  │     → signed `{ ok: true, protocolVersion: "v1" }`
  └─ 3. type = "agent-games.proof-gatekeeper.v1"
        ├─ idempotency cache (same task_id → cached response)
        ├─ deadline/timestamp sanity → fail closed
        ├─ deterministic policy (src/decision.js) → decision + reason_code
        ├─ snarkjs fullProve with gatekeeper.wasm / gatekeeper_final.zkey
        │    (skipped only for PROOF_REUSED — documented as having no proof)
        ├─ Kurier submit + bounded poll (≤8 s) → on-chain txHash as proof_tx
        └─ signed JSON response
```

Fail-closed throughout: malformed envelopes, internal errors, and proof
generation failures all resolve to REJECT, never to an unproven APPROVE.

### Decision rules (mirroring the circuit exactly, boundaries included)

APPROVE only if `proof_vk == registered_vk`, `proof_tx` unseen,
`public_balance >= minimum`, `current_block < expiry_block`,
`recipient == condition_recipient`, and `amount <= max_transfer`.
Otherwise the matching trap code is returned:

| Condition | reason_code |
| --- | --- |
| proof_vk != registered_vk | VK_SUBSTITUTION |
| proof_tx already seen | PROOF_REUSED (no proof attached) |
| public_balance < minimum | THRESHOLD_MISMATCH |
| current_block >= expiry_block | EXPIRED_CONDITION |
| recipient != condition_recipient | RECIPIENT_MISMATCH |
| amount > max_transfer | AMOUNT_OVERFLOW |
| all checks pass | VALID_CONDITION (APPROVE) |

### Response shape

```json
{
  "decision": "APPROVE" | "REJECT",
  "reason_code": "VALID_CONDITION" | "VK_SUBSTITUTION" | "PROOF_REUSED"
               | "THRESHOLD_MISMATCH" | "EXPIRED_CONDITION"
               | "RECIPIENT_MISMATCH" | "AMOUNT_OVERFLOW",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 field elements>"],
  "proof_tx": "0x…"
}
```

plus the `x-agent-games-signature` header (HMAC over the raw response body).
When no Kurier key is configured, `proof_tx` echoes the task's input
`proof_tx` (matching the sample response shape on the event page).

### The circuit

The official artifacts (`circuits/gatekeeper.wasm`,
`circuits/gatekeeper_final.zkey`) are published on the Agent Games build page
(see also `/api/circuit-info`); their SHA-256 hashes are recorded in
`scripts/download-circuits.js`. `circuits/verification_key.json` was extracted
from the proving key for local proof verification in the test harness.

Registered gatekeeper vk_hash on zkVerify mainnet:
`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`

Circuit inputs (13): `taskId, registeredVkHash, proofVkHash, minimum,
publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient,
amount, maxTransfer, decision, salt (private)` — and it emits 13 public
signals: `[Poseidon(taskId, salt), registeredVkHash, proofVkHash, minimum,
publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient,
amount, maxTransfer, decision, taskId]`. The circuit **asserts
`decision == (all field checks)`**: witness generation fails for
`decision=1` on a trapped statement and for `decision=0` on a valid one —
verified experimentally (see Local test results). Field elements are the
envelope values reduced mod the BN128 prime. `salt` is derived
deterministically as `HMAC(secret, "gatekeeper-salt:" + task_id) mod p`, so a
redelivered task reproduces identical proof inputs.

## File layout

| Path | Purpose |
| --- | --- |
| `api/agent.js` | Vercel serverless entry (`bodyParser: false` → raw body for HMAC). |
| `server.js` | Plain Node HTTP server (`npm start`). |
| `src/handler.js` | Framework-agnostic request pipeline shared by both entries. |
| `src/hmac.js` | HMAC sign/verify + per-task circuit salt derivation. |
| `src/decision.js` | Deterministic policy + envelope→circuit field conversion. |
| `src/prover.js` | snarkjs `groth16.fullProve` wrapper. |
| `src/kurier.js` | Kurier submit-proof + job-status polling (never throws). |
| `src/seenStore.js` | proof_tx seen-set + response cache, file-backed and/or Upstash Redis. |
| `src/config.js` | Environment-variable configuration. |
| `circuits/` | `gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json`. |
| `scripts/download-circuits.js` | Re-download official artifacts (+ SHA-256 check). |
| `test/harness.js` | Local end-to-end harness (`npm test`). |

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | yes | Platform-generated; dashboard → agent → **Rotate Secret**, copy the one-time plaintext. Never a local placeholder. |
| `KURIER_API_KEY` | no | Mainnet Kurier key — **free**, sign up at https://kurier.xyz and generate one from the dashboard. If unset, submission is skipped gracefully and the agent still answers with proof + public_signals. |
| `KURIER_API_URL` | no | Default `https://api.kurier.xyz/api/v1` (mainnet). |
| `GATEKEEPER_VK_HASH` | no | Defaults to the registered gatekeeper vk_hash above. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Durable seen-set for serverless. Create in Vercel: Storage → Create → Upstash Redis (free tier); Vercel injects these automatically when linked. |
| `KURIER_POLL_BUDGET_MS` | no | Default 8000. |
| `TASK_SOFT_DEADLINE_MS` | no | Default 50000 (hard platform deadline is 60 s). |
| `SEEN_STORE_PATH` | no | Default `data/seen.json` locally, `/tmp/…` on Vercel. |
| `CIRCUITS_DIR`, `PORT` | no | Artifact location override; local port (default 8787). |

No secrets are hardcoded anywhere; `.env` is gitignored and `.env.example` ships blank values.

## Local development

```bash
npm install
npm run download-circuits   # refresh official artifacts (optional; already committed)
cp .env.example .env        # fill AGENT_GAMES_HMAC_SECRET with a TEST value
npm start                   # listens on :8787 (POST /agent)
npm test                    # full harness, 30 checks (uses its own test secret)
```

## Deploy (Vercel)

1. Push this repo to GitHub (public).
2. In Vercel, **Add New → Project → Import** this repository.
3. Framework Preset: **Other**. Root Directory: repo root. No build command
   needed (plain Node; `api/agent.js` is the serverless function).
4. Environment Variables:
   - `AGENT_GAMES_HMAC_SECRET` — paste the secret from the Agent Games
     dashboard (see Registration below). **Not yet known at deploy time:
     deploy once without it, then add it and redeploy.**
   - `KURIER_API_KEY` — optional (free key from https://kurier.xyz).
5. Deploy. Your endpoint is `https://<project>.vercel.app/agent`.
6. (Recommended for the PROOF_REUSED trap) In Vercel: **Storage → Create →
   Upstash Redis** (free tier) and link it to this project — the
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` variables are
   injected automatically and the seen-set survives cold starts. Without it,
   the seen-set lives in memory + `/tmp` on Vercel and can reset when an
   instance cold-starts; within a round, warm instances retain it.
   Alternative: run `npm start` on a single long-lived host (VM/container)
   where `data/seen.json` persists.

`vercel.json` sets `maxDuration: 60` for the function. If your Vercel plan
rejects that value, remove the line (the default limit is enough: proving
takes ~1 s and the Kurier poll budget defaults to 8 s).

## Registration & preflight flow

1. Deploy (above). Confirm `GET https://<host>/agent` returns
   `{ "ok": true, "protocolVersion": "v1" }`.
2. In the Agent Games dashboard, **Register a new agent**:
   - Agent name: `SIKARIM-GK`
   - Event tracks: ☑ **Proof Gatekeeper** only
   - Repository URL: `https://github.com/Fslrm123/agent-games-gatekeeper`
   - Agent endpoint: `https://<host>/agent` (the full handler path, not the root)
3. Dashboard → your agent → **Rotate Secret** → copy the one-time plaintext
   → set it as `AGENT_GAMES_HMAC_SECRET` in Vercel → redeploy.
4. The platform sends a signed preflight (`type: agent-games.preflight.v1`);
   this agent answers `{ ok: true, protocolVersion: "v1" }` signed, and the
   dashboard marks the agent healthy.
5. Complete at least one practice task (Dashboard → Practice) before scored
   rounds. Scored rounds run daily 13–21 Nov 2026, 4:00 PM–2:00 AM IST
   (17:30–03:30 WIB), 8 tasks per agent per round.

## Local test results

`npm test` boots the real server and replays spec-shaped envelopes —
**30/30 checks pass**, including:

- HMAC roundtrip; tamper/wrong-secret/missing → 401
- Preflight body shape + valid response signature; server without secret → 500
- Valid task → APPROVE / VALID_CONDITION, proof **verified locally** with
  `snarkjs groth16 verify` against the extracted verification key; public
  signals match the inputs at positions 1–12
- All six trap classes → correct REJECT + reason_code, each proof verified
  (PROOF_REUSED correctly carries no proof)
- Idempotent redelivery (identical cached body, not misread as reuse)
- Boundaries: balance == minimum → APPROVE; amount == max_transfer →
  APPROVE; current_block == expiry_block → REJECT
- Response times: ~1.0 s cold (incl. WASM load), ~0.3–0.4 s warm — far
  under the 60 s deadline even with the 8 s Kurier budget on top

Circuit referee check (probe, before the service was built): proving
`decision=1` on a trapped statement and `decision=0` on a valid statement
both fail witness generation (`Assert Failed ... GatekeeperEvaluation line:
102`) — a wrong decision is unprovable by construction.

## Known limitations (honest notes)

- **Input-proof on-chain check:** the build checklist says to "confirm the
  proof is on-chain via zkVerifyJS". The task envelope carries no
  independently checkable finality proof for the referenced on-chain proof,
  and zkVerifyJS needs a funded Volta session (a seed phrase + tVFY) to query
  the chain. This agent therefore validates every checkable field from the
  platform-signed envelope (VK equality, balance, recipient, expiry, reuse,
  amount) — the same approach as the reference implementation — and treats
  the platform's signed dispatch as attestation that the referenced proof
  exists. If the platform ever sends a proof_tx that does not exist
  on-chain, this agent cannot detect that from the envelope alone.
- **Seen-set durability on serverless:** see Deploy step 6. Without Redis
  (or a long-lived host), a cold start can forget previously seen proof
  references and a replayed proof could be approved. Enable the Redis
  backend for the scored rounds.
- **Kurier is optional:** without a key the agent still answers with a valid
  local proof; `proof_tx` then echoes the task's input reference. With a
  key, the response carries the real on-chain submission hash.
- **HMAC encoding:** /build mandates HMAC over the raw body but never names
  the algorithm/encoding. Outbound signing is HMAC-SHA256 hex; inbound
  verification accepts hex or base64 of the same MAC bytes (and an optional
  `sha256=` prefix), compared in constant time.
- **`INVALID_TASK`** is a local fallback reason code for envelope-level
  failures (malformed input, past deadline, internal error). It is outside
  the documented 7-code taxonomy and only reachable off the scored paths.
