const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Leadflow webhook running");
});

app.post("/whatsapp", (req, res) => {
  const phone = req.body.From;
  const message = req.body.Body;

  console.log("New WhatsApp message:");
  console.log(phone, message);

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
