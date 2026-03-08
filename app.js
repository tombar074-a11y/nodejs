const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Temporary in-memory store for testing
const leads = new Map();

/**
 * Create or update a lead from an incoming WhatsApp message
 */
function ingestWhatsAppMessage({ phone, message, timestamp }) {
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

function formatWaitingTime(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 7) return `${days}d`;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

app.get("/", (req, res) => {
  res.send("Leadflow webhook running");
});

// All leads
app.get("/debug/leads", (req, res) => {
  res.json({
    count: leads.size,
    leads: Array.from(leads.values()),
  });
});

// Only leads waiting for reply
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

app.post("/whatsapp", (req, res) => {
  try {
    const phone = req.body.From;
    const message = req.body.Body;
    const timestamp = new Date().toISOString();

    if (!phone || !message) {
      return res.status(400).json({ error: "Missing phone or message" });
    }

    const result = ingestWhatsAppMessage({
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
