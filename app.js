const express = require("express");
const cors = require("cors");
const app = express();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: {
    rejectUnauthorized: false
  }
}); 
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      source TEXT,
      last_message TEXT,
      last_message_time TIMESTAMP,
      followup_needed BOOLEAN
    );
  `);
await pool.query(`
  ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS alert_sent BOOLEAN DEFAULT FALSE
`);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    lead_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    message_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )
`);
  await pool.query(`
  ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type TEXT
`);

await pool.query(`
  ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_effort TEXT
`);
  console.log("Database ready");
}

initDB();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
// Temporary in-memory store for testing
const leads = new Map();
function classifyMessage(message, waiting_minutes = 0) {
  const msg = (message || "").toLowerCase().trim();

  const leadKeywords = [
  "price", "pricing", "how much", "membership", "trial", "start", "join",
  "available", "schedule",
  "כמה", "כמה זה", "כמה עולה", "מחיר", "עלות", "מנוי", "ניסיון",
  "להתחיל", "להצטרף", "פרטים", "זמין"
];

  const closingKeywords = [
    "thanks", "thank you", "perfect", "great", "awesome", "amazing",
    "תודה", "תודה רבה", "מושלם", "מעולה", "אלוף", "מלך", "🙏", "👍", "❤️", "❤"
  ];

  const shortReplyKeywords = [
    "מתי", "איפה", "אפשר", "שלחת?", "קיבלת?", "מחר", "היום",
    "when", "where", "can you", "did you send", "got it"
  ];

  if (closingKeywords.some((k) => msg.includes(k))) {
    return {
      message_type: "closing",
      reply_effort: "quick"
    };
  }

  if (leadKeywords.some((k) => msg.includes(k))) {
    return {
      message_type: "lead",
      reply_effort: "full"
    };
  }

  if (shortReplyKeywords.some((k) => msg.includes(k))) {
    return {
      message_type: "existing_customer",
      reply_effort: "short"
    };
  }

  if (waiting_minutes >= 60) {
    return {
      message_type: "existing_customer",
      reply_effort: "full"
    };
  }

  return {
    message_type: "existing_customer",
    reply_effort: "short"
  };
}
async function ingestWhatsAppMessage({ phone, message, timestamp }) {
  await pool.query(
    `
    INSERT INTO leads (id, name, source, last_message, last_message_time, followup_needed)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id)
    DO UPDATE SET
      name = EXCLUDED.name,
      source = EXCLUDED.source,
      last_message = EXCLUDED.last_message,
      last_message_time = EXCLUDED.last_message_time,
      followup_needed = EXCLUDED.followup_needed
    `,
    [phone, phone, "whatsapp", message, timestamp, true]
  );

  const classification = classifyMessage(message, 0);

  await pool.query(
    `INSERT INTO messages (lead_id, direction, message_text, created_at, message_type, reply_effort)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      phone,
      "inbound",
      message,
      timestamp,
      classification.message_type,
      classification.reply_effort
    ]
  );

  const existingLead = leads.get(phone);


  if (!existingLead) {
    leads.set(phone, {
      id: phone,
      name: phone,
      source: "whatsapp",
      external_id: phone,
      last_message: message,
      last_message_time: timestamp,
      followup_needed: true,
      messages: [
        {
          sender: "lead",
          platform: "whatsapp",
          message_text: message,
          created_at: timestamp,
        },
      ],
    });

    return { action: "created", lead: leads.get(phone) };
  }

  existingLead.last_message = message;
  existingLead.last_message_time = timestamp;
  existingLead.followup_needed = true;
  existingLead.messages.push({
    sender: "lead",
    platform: "whatsapp",
    message_text: message,
    created_at: timestamp,
  });

  return { action: "updated", lead: existingLead };
}

function getMinutesSince(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  return Math.floor(diffMs / 60000);
}

function formatWaitingTime(isoDate) {
  const totalMinutes = getMinutesSince(isoDate);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getAttentionLevel(isoDate) {
  const minutes = getMinutesSince(isoDate);

  if (minutes < 120) return "waiting";       // under 2h
  if (minutes < 720) return "at_risk";       // 2h–12h
  if (minutes < 1440) return "urgent";       // 12h–24h
  return "lost";                             // 24h+
}

app.get("/", (req, res) => {
  res.send("Leadflow webhook running");
});

app.get("/debug/leads", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed
      FROM leads
      ORDER BY last_message_time DESC
    `);

    res.json({
      count: result.rows.length,
      leads: result.rows,
    });
  } catch (error) {
    console.error("Debug leads error:", error);
    res.status(500).json({ error: "Failed to fetch leads from database" });
  }
});
app.get("/debug/waiting", (req, res) => {
  const waitingLeads = Array.from(leads.values())
    .filter((lead) => lead.followup_needed === true)
    .map((lead) => ({
      id: lead.id,
      name: lead.name,
      source: lead.source,
      last_message: lead.last_message,
      last_message_time: lead.last_message_time,
      waiting_time: formatWaitingTime(lead.last_message_time),
      attention_level: getAttentionLevel(lead.last_message_time),
      followup_needed: lead.followup_needed,
    }))
    .sort(
      (a, b) =>
        new Date(a.last_message_time).getTime() -
        new Date(b.last_message_time).getTime()
    );

  res.json({
    count: waitingLeads.length,
    leads: waitingLeads,
  });
});

app.get("/alerts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed
      FROM leads
      WHERE followup_needed = true
      ORDER BY last_message_time DESC
    `);

    const now = Date.now();

    const leads = result.rows.map((lead) => {
      const minutes =
        Math.floor((now - new Date(lead.last_message_time).getTime()) / 60000);

      let level = "waiting";
      if (minutes >= 1440) level = "lost";
      else if (minutes >= 720) level = "urgent";
      else if (minutes >= 120) level = "at_risk";

      return {
        ...lead,
        waiting_minutes: minutes,
        level,
      };
    });

    const alerts = {
      at_risk: leads.filter((l) => l.level === "at_risk"),
      urgent: leads.filter((l) => l.level === "urgent"),
      lost: leads.filter((l) => l.level === "lost"),
    };

    res.json({
      alerts_count:
        alerts.at_risk.length + alerts.urgent.length + alerts.lost.length,
      alerts,
    });
  } catch (error) {
    console.error("Alerts error:", error);
    res.status(500).json({ error: "Failed to fetch alerts from database" });
  }
});
app.get("/attention", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed
      FROM leads
      WHERE followup_needed = true
      ORDER BY last_message_time ASC
    `);

    const now = Date.now();

    const leads = result.rows.map((lead) => {
      const minutes = Math.floor(
        (now - new Date(lead.last_message_time).getTime()) / 60000
      );

      let attention_level = "waiting";
      if (minutes >= 1440) attention_level = "lost";
      else if (minutes >= 720) attention_level = "urgent";
      else if (minutes >= 120) attention_level = "at_risk";

      return {
        id: lead.id,
        name: lead.name,
        source: lead.source,
        last_message: lead.last_message,
        last_message_time: lead.last_message_time,
        waiting_minutes: minutes,
        attention_level,
      };
    });

    res.json({
      count: leads.length,
      leads,
    });
  } catch (error) {
    console.error("Attention error:", error);
    res.status(500).json({ error: "Failed to fetch attention leads" });
  }
});
app.get("/ghosted", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, last_message, last_message_time
      FROM leads
      WHERE followup_needed = true
      AND last_message_time < NOW() - INTERVAL '12 hours'
      ORDER BY last_message_time ASC
    `);

    res.json({
      count: result.rows.length,
      ghosted_leads: result.rows
    });

  } catch (error) {
    console.error("Ghosted leads error:", error);
    res.status(500).json({ error: "Failed to fetch ghosted leads" });
  }
});
app.get("/prioritized-ghosted", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time
      FROM leads
      WHERE followup_needed = true
      AND last_message_time < NOW() - INTERVAL '12 hours'
      ORDER BY last_message_time ASC
    `);

    const leads = result.rows.map((lead) => {
      const msg = (lead.last_message || "").toLowerCase();

      let priority = "medium";

      const highKeywords = [
        "price",
        "pricing",
        "how much",
        "membership",
        "trial",
        "start",
        "join",
        "schedule",
        "available",
        "כמה עולה",
        "מחיר",
        "עלות",
        "מנוי",
        "ניסיון",
        "להתחיל",
        "להצטרף",
        "זמין",
        "שעות"
      ];

      const lowKeywords = [
        "thanks",
        "thank you",
        "ok",
        "okay",
        "maybe",
        "later",
        "סבבה",
        "תודה",
        "אוקיי",
        "אולי",
        "אחר כך"
      ];

      if (highKeywords.some((keyword) => msg.includes(keyword))) {
        priority = "high";
      } else if (lowKeywords.some((keyword) => msg.includes(keyword))) {
        priority = "low";
      }

      return {
        ...lead,
        priority
      };
    });

    res.json({
      count: leads.length,
      ghosted_leads: leads
    });
  } catch (error) {
    console.error("Prioritized ghosted error:", error);
    res.status(500).json({ error: "Failed to fetch prioritized ghosted leads" });
  }
});
app.get("/dashboard-data", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed
      FROM leads
      ORDER BY last_message_time DESC
    `);

    const now = Date.now();

    const allLeads = result.rows.map((lead) => {
      const minutes = Math.floor(
        (now - new Date(lead.last_message_time).getTime()) / 60000
      );

      let attention_level = "waiting";
      if (minutes >= 1440) attention_level = "lost";
      else if (minutes >= 720) attention_level = "urgent";
      else if (minutes >= 120) attention_level = "at_risk";

      const msg = (lead.last_message || "").toLowerCase();
      let priority = "medium";

      const highKeywords = [
        "price", "pricing", "how much", "membership", "trial", "start", "join",
        "schedule", "available", "כמה עולה", "מחיר", "עלות", "מנוי",
        "ניסיון", "להתחיל", "להצטרף", "זמין", "שעות"
      ];

      const lowKeywords = [
        "thanks", "thank you", "ok", "okay", "maybe", "later",
        "סבבה", "תודה", "אוקיי", "אולי", "אחר כך"
      ];

      if (highKeywords.some((keyword) => msg.includes(keyword))) {
        priority = "high";
      } else if (lowKeywords.some((keyword) => msg.includes(keyword))) {
        priority = "low";
      }

      return {
        ...lead,
        waiting_minutes: minutes,
        attention_level,
        priority
      };
    });

    const attention = allLeads.filter(
  (lead) => lead.followup_needed === true || lead.followup_needed === "true"
);
    const ghosted = attention.filter((lead) => lead.waiting_minutes >= 720);

    const prioritizedGhosted = {
      high: ghosted.filter((lead) => lead.priority === "high"),
      medium: ghosted.filter((lead) => lead.priority === "medium"),
      low: ghosted.filter((lead) => lead.priority === "low"),
    };

    const alerts = {
      at_risk: attention.filter((lead) => lead.attention_level === "at_risk"),
      urgent: attention.filter((lead) => lead.attention_level === "urgent"),
      lost: attention.filter((lead) => lead.attention_level === "lost"),
    };

    res.json({
      counts: {
        total_leads: allLeads.length,
        needs_reply: attention.length,
        at_risk: alerts.at_risk.length,
        urgent: alerts.urgent.length,
        lost: alerts.lost.length,
        ghosted_high: prioritizedGhosted.high.length,
        ghosted_medium: prioritizedGhosted.medium.length,
        ghosted_low: prioritizedGhosted.low.length
      },
      attention,
      alerts,
      prioritized_ghosted: prioritizedGhosted
    });
  } catch (error) {
    console.error("Dashboard data error:", error);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});
app.get("/push-candidates", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed
      FROM leads
      ORDER BY last_message_time DESC
    `);

    const now = Date.now();

    const highKeywords = [
      "price",
      "pricing",
      "how much",
      "membership",
      "trial",
      "start",
      "join",
      "schedule",
      "available",
      "כמה עולה",
      "מחיר",
      "עלות",
      "מנוי",
      "ניסיון",
      "להתחיל",
      "להצטרף",
      "זמין",
      "שעות"
    ];

    const leads = result.rows.map((lead) => {
      const msg = (lead.last_message || "").toLowerCase();
      const waiting_minutes = Math.floor(
        (now - new Date(lead.last_message_time).getTime()) / 60000
      );

      const is_hot = highKeywords.some((keyword) => msg.includes(keyword));
      const is_ignored =
        (lead.followup_needed === true || lead.followup_needed === "true") &&
        waiting_minutes >= 720;

      return {
        ...lead,
        waiting_minutes,
        is_hot,
        is_ignored
      };
    });

    const hot_leads = leads
      .filter((lead) => lead.is_hot)
      .map((lead) => ({
        id: lead.id,
        name: lead.name,
        last_message: lead.last_message,
        reason: "High intent detected from message content",
        priority: "high"
      }));

    const ignored_leads = leads
      .filter((lead) => lead.is_ignored)
      .map((lead) => ({
        id: lead.id,
        name: lead.name,
        last_message: lead.last_message,
        waiting_minutes: lead.waiting_minutes
      }));

    const followup_opportunities = [];

    res.json({
      counts: {
        hot_leads: hot_leads.length,
        ignored_leads: ignored_leads.length,
        followup_opportunities: followup_opportunities.length
      },
      hot_leads,
      ignored_leads,
      followup_opportunities
    });
  } catch (error) {
    console.error("Push candidates error:", error);
    res.status(500).json({ error: "Failed to fetch push candidates" });
  }
});
app.get("/daily-brief", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT id, last_message, last_message_time, followup_needed
      FROM leads
    `);

    const now = Date.now();

    const highKeywords = [
      "price","pricing","how much","membership","trial","start","join","schedule",
      "available","כמה עולה","מחיר","עלות","מנוי","ניסיון","להתחיל","להצטרף"
    ];

    let hot_leads = 0;
    let ignored_leads = 0;
    let followups = 0;

    for (const lead of result.rows) {

      const msg = (lead.last_message || "").toLowerCase();

      const waiting_minutes = Math.floor(
        (now - new Date(lead.last_message_time).getTime()) / 60000
      );

      const is_hot = highKeywords.some(k => msg.includes(k));

      const is_ignored =
        lead.followup_needed === true &&
        waiting_minutes >= 720;

      const is_followup =
        lead.followup_needed === true &&
        waiting_minutes >= 1440;

      if (is_hot) hot_leads++;
      if (is_ignored) ignored_leads++;
      if (is_followup) followups++;

    }

    const potential_sales_conversations =
      hot_leads + ignored_leads + followups;

    res.json({
      hot_leads,
      ignored_leads,
      followups,
      potential_sales_conversations
    });
      } catch (error) {
    console.error("Daily brief error:", error);
    res.status(500).json({
      error: "Failed to generate daily brief"
    });
  }
});
app.get("/dashboard-summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, source, last_message, last_message_time, followup_needed, alert_sent
      FROM leads
      ORDER BY last_message_time DESC
    `);

    const now = Date.now();

    const highKeywords = [
      "price","pricing","how much","membership","trial","start","join","schedule",
      "available","כמה עולה","מחיר","עלות","מנוי","ניסיון","להתחיל","להצטרף"
    ];

    const leads = result.rows.map((lead) => {
      const msg = (lead.last_message || "").toLowerCase();

      const waiting_minutes = Math.floor(
        (now - new Date(lead.last_message_time).getTime()) / 60000
      );

      const is_hot = highKeywords.some((k) => msg.includes(k));
      const is_ignored =
        lead.followup_needed === true &&
        waiting_minutes >= 720;
      const is_followup =
        lead.followup_needed === true &&
        waiting_minutes >= 1440;

      let attention_level = "waiting";
      if (waiting_minutes >= 1440) attention_level = "lost";
      else if (waiting_minutes >= 720) attention_level = "urgent";
      else if (waiting_minutes >= 120) attention_level = "at_risk";

      return {
        ...lead,
        waiting_minutes,
        is_hot,
        is_ignored,
        is_followup,
        attention_level
      };
    });

    const hot_leads = leads.filter((lead) => lead.is_hot).length;
    const ignored_leads = leads.filter((lead) => lead.is_ignored).length;
    const followups = leads.filter((lead) => lead.is_followup).length;

    const potential_sales_conversations =
      hot_leads + ignored_leads + followups;

    const alerts = leads.filter(
      (lead) =>
        lead.alert_sent === false &&
        (lead.is_hot || lead.is_ignored)
    );

    const attention = leads.filter(
      (lead) => lead.followup_needed === true
    );

    res.json({
      daily_brief: {
        hot_leads,
        ignored_leads,
        followups,
        potential_sales_conversations
      },
      alerts,
      attention
    });

  } catch (error) {
    console.error("Dashboard summary error:", error);

    res.status(500).json({
      error: "Failed to fetch dashboard summary"
    });
  }
});
app.get("/push-dispatch", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT id, name, last_message, last_message_time, followup_needed, alert_sent
      FROM leads
      ORDER BY last_message_time DESC
    `);

    const now = Date.now();

    const highKeywords = [
      "price","pricing","how much","membership","trial","start","join","schedule",
      "available","כמה עולה","מחיר","עלות","מנוי","ניסיון","להתחיל","להצטרף"
    ];

    const leads = Array.isArray(result.rows)
      ? result.rows.map((lead) => {

          const msg = (lead.last_message || "").toLowerCase();

          const waiting_minutes = Math.floor(
            (now - new Date(lead.last_message_time).getTime()) / 60000
          );

          const is_hot = highKeywords.some((k) => msg.includes(k));

          const is_ignored =
            lead.followup_needed === true &&
            waiting_minutes >= 720;

          return {
            ...lead,
            waiting_minutes,
            is_hot,
            is_ignored
          };

        })
      : [];

    const alerts = leads.filter(
      (lead) =>
        lead.alert_sent === false &&
        (lead.is_hot || lead.is_ignored)
    );

    for (const lead of alerts) {

      await pool.query(
        `UPDATE leads SET alert_sent = true WHERE id = $1`,
        [lead.id]
      );

    }

    res.json({ alerts });

  } catch (error) {

    console.error("Push dispatch error:", error);

    res.status(500).json({
      error: "Failed to dispatch alerts"
    });

  }
});
app.get("/debug/messages", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, lead_id, direction, message_text, message_type, reply_effort, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT 20
    `);

    return res.json({
      count: result.rows.length,
      messages: result.rows
    });
  } catch (error) {
    console.error("Debug messages error:", error);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
});
app.post("/resolve", async (req, res) => {
  try {
    const { id } = req.body;

    await pool.query(
      `UPDATE leads
       SET followup_needed = false
       WHERE id = $1`,
      [id]
    );

    return res.json({ status: "resolved", id });
  } catch (error) {
    console.error("Resolve error:", error);
    return res.status(500).json({ error: "Failed to resolve lead" });
  }
});
app.get("/priority-inbox", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT lead_id, message_text, message_type, reply_effort, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const hot_leads = [];
    const needs_attention = [];
    const quick_replies = [];

    result.rows.forEach(msg => {

      if (msg.message_type === "lead") {
        hot_leads.push(msg);
      }

      else if (msg.reply_effort === "short") {
        needs_attention.push(msg);
      }

      else if (msg.message_type === "closing") {
        quick_replies.push(msg);
      }

    });

    res.json({
      hot_leads,
      needs_attention,
      quick_replies
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build priority inbox" });
  }
});
app.get("/resolve-test", async (req, res) => {
  try {
    const id = req.query.id;

    await pool.query(
      `UPDATE leads
       SET followup_needed = false
       WHERE id = $1`,
      [id]
    );

    res.send(`Resolved ${id}`);
  } catch (error) {
    console.error("Resolve test error:", error);
    res.status(500).send("Resolve test failed");
  }
});
app.post("/whatsapp", async (req, res) => {
  try {
    const phone = req.body.From;
    const message = req.body.Body;
    const timestamp = new Date().toISOString();

    if (!phone || !message) {
      return res.status(400).json({ error: "Missing phone or message" });
    }

 const result = await ingestWhatsAppMessage({
      phone,
      message,
      timestamp,
    });

    console.log("NEW WHATSAPP MESSAGE");
    console.log("Phone:", phone);
    console.log("Message:", message);
    console.log("Lead action:", result.action);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
