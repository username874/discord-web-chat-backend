
require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});

