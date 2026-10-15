
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("Private Discord Chat backend is running!");
});

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});

