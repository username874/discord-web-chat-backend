
require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const requiredEnv = [
    "DISCORD_TOKEN",
    "DISCORD_CHANNEL_ID",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CHAT_PASSWORD"
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

discord.once("ready", () => {
    console.log(`Discord bot logged in as ${discord.user.tag}`);
});

discord.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error.message);
});

app.get("/", (req, res) => {
    res.send("Private Discord Chat backend is running!");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        discordReady: discord.isReady()
    });
});

app.post("/login", (req, res) => {
    const { password } = req.body || {};

    if (
        typeof password !== "string" ||
        password.length > 200 ||
        password !== process.env.CHAT_PASSWORD
    ) {
        return res.status(401).json({ error: "Incorrect password" });
    }

    res.json({
        ok: true,
        message: "Password accepted for testing only"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});
