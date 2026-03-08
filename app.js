const express = require("express");
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

  console.log("Database ready");
}

initDB();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Temporary in-memory store for testing
const leads = new Map();

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
app.post("/resolve", async (req, res) => {
  try {
    const { id } = req.body;

    await pool.query(
      `UPDATE leads
       SET followup_needed = false
       WHERE id = $1`,
      [id]
    );

    res.json({ status: "resolved", id });
  } catch (error) {
    console.error("Resolve error:", error);
    res.status(500).json({ error: "Failed to resolve lead" });
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
