// Download the official gatekeeper circuit artifacts from Agent Games.
// Run: npm run download-circuits
// (The artifacts are committed to this repo as well, so deploys work without
// this step; this script is for refreshing them if the tournament rotates keys.)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = "https://agentgames.zkverify.io/circuits";
const FILES = ["gatekeeper.wasm", "gatekeeper_final.zkey"];
const EXPECTED_SHA256 = {
  "gatekeeper.wasm": "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
  "gatekeeper_final.zkey": "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
};

async function main() {
  const dir = path.resolve(__dirname, "..", "circuits");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of FILES) {
    const url = `${BASE}/${file}`;
    const dest = path.join(dir, file);
    console.log(`downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const expected = EXPECTED_SHA256[file];
    console.log(`  ${file}: ${buf.length} bytes, sha256 ${hash}`);
    if (expected && hash !== expected) {
      console.warn(`  WARNING: sha256 differs from the recorded value ${expected}`);
    }
  }
  console.log("done.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
