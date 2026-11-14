// Vercel serverless entry for POST /agent.
// bodyParser is disabled so the handler receives the RAW body for HMAC
// verification. The handler is shared with the plain Node server (server.js).
const { loadConfig } = require("../src/config");
const { AgentHandler, SIGNATURE_HEADER } = require("../src/handler");
const { SeenStore } = require("../src/seenStore");

const cfg = loadConfig();
const store = new SeenStore(cfg.seenStorePath, {
  url: cfg.upstashUrl,
  token: cfg.upstashToken,
});
const handler = new AgentHandler(cfg, store);

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const r = handler.health();
    res.status(r.status).json(JSON.parse(r.body));
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  // Read the raw body from the stream (no JSON parsing before HMAC check).
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const signature = req.headers[SIGNATURE_HEADER];
  const result = await handler.handlePost(
    rawBody,
    Array.isArray(signature) ? signature[0] : signature,
  );
  if (result.signature) res.setHeader(SIGNATURE_HEADER, result.signature);
  res.status(result.status).setHeader("content-type", "application/json").send(result.body);
};

module.exports.config = { api: { bodyParser: false } };
