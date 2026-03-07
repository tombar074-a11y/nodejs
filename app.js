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

  console.log("NEW WHATSAPP MESSAGE");
  console.log("Phone:", phone);
  console.log("Message:", message);

  res.send("ok");

});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
