/**
 * Veyra AI — customer support API
 *
 * MVP backend. Keep API keys on the server; never put them in browser code.
 * Requires Node.js 20+ and the dependencies in package.json.
 */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Sample Business";
const BUSINESS_FAQ = process.env.BUSINESS_FAQ || "No verified business FAQ has been configured.";

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server and local CLI requests without an Origin header.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "12kb" }));
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
}));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Veyra AI",
    mode: openai ? "ai-configured" : "demo-no-api-key",
    model: openai ? MODEL : null,
  });
});

function shouldEscalate(text) {
  return /\b(human|real person|staff member|manager|supervisor|urgent|emergency|complaint|cancel my booking|refund|speak to someone)\b/i.test(text);
}

app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Please enter a message." });
  }
  if (message.length > 4000) {
    return res.status(413).json({ error: "Message is too long. Please keep it under 4,000 characters." });
  }
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: "Conversation history must be a list." });
  }

  const safeHistory = history
    .slice(-8)
    .filter((item) =>
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string" &&
      item.content.length <= 4000
    )
    .map((item) => ({ role: item.role, content: item.content }));

  const needsHuman = shouldEscalate(message);

  if (!openai) {
    return res.status(503).json({
      error: "Live AI is not configured yet. Add OPENAI_API_KEY to the server environment.",
      demo: true,
      needsHuman,
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the customer support assistant for ${BUSINESS_NAME}.
Use ONLY the approved business information below for factual business claims.
If information is missing, say you cannot verify it and offer a staff handoff.
Never invent prices, availability, policies, bookings, or completed actions.
Be warm, concise, professional, and natural. Do not claim you contacted staff or completed a booking.
For complaints, refunds, emergencies, sensitive requests, or uncertain answers, recommend human staff.
Return a JSON object with exactly these keys:
{"reply":"customer-facing answer","needsHuman":true or false,"handoffReason":"short reason or empty string"}.
Approved business information:
${BUSINESS_FAQ}`,
        },
        ...safeHistory,
        { role: "user", content: message.trim() },
      ],
    });

    const raw = completion.choices[0]?.message?.content || "";
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { reply: raw || "I’m sorry, I couldn’t prepare an answer. Please contact our team.", needsHuman: true, handoffReason: "AI response could not be parsed." };
    }

    const reply = typeof result.reply === "string" ? result.reply.slice(0, 5000) : "I’m sorry, I couldn’t prepare an answer. Please contact our team.";
    res.json({
      reply,
      needsHuman: Boolean(result.needsHuman || needsHuman),
      handoffReason: typeof result.handoffReason === "string" ? result.handoffReason.slice(0, 300) : "",
      mode: "live-ai",
    });
  } catch (error) {
    // Do not return API keys, provider details, or internal stack traces to the client.
    console.error("Veyra chat request failed:", error?.message || "Unknown error");
    res.status(502).json({
      error: "The assistant is temporarily unavailable. Please try again or contact staff.",
      needsHuman: true,
    });
  }
});

// Serve the prototype website and API from one Node deployment.
app.use(express.static(__dirname));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Veyra AI server listening on port ${PORT}`);
});
