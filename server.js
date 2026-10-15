
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
        console.error(`Missing environment variable: ${key}`);
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

async function removeOldMessages() {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { error } = await supabase
        .from("messages")
        .delete()
        .lt("created_at", cutoff);

    if (error) {
        console.error("Could not remove old messages:", error.message);
    }
}

async function saveMessage(message) {
    if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;
    if (message.author.system) return;
    if (!message.content.trim()) return;

    const { error } = await supabase
        .from("messages")
        .upsert(
            {
                discord_message_id: message.id,
                sender:
                    message.member?.displayName ||
                    message.author.globalName ||
                    message.author.username,
                content: message.content,
                created_at: message.createdAt.toISOString()
            },
            { onConflict: "discord_message_id" }
        );

    if (error) {
        console.error("Could not save Discord message:", error.message);
    } else {
        await removeOldMessages();
    }
}

discord.once("ready", async () => {
    console.log(`Discord bot logged in as ${discord.user.tag}`);

    try {
        const channel = await discord.channels.fetch(
            process.env.DISCORD_CHANNEL_ID
        );

        if (!channel || !channel.isTextBased() || !channel.messages) {
            console.error("The configured channel is not a readable text channel.");
            return;
        }

        const recentMessages = await channel.messages.fetch({ limit: 100 });
        const cutoff = Date.now() - 5 * 60 * 1000;

        for (const message of recentMessages.values()) {
            if (message.createdTimestamp >= cutoff) {
                await saveMessage(message);
            }
        }

        await removeOldMessages();
        console.log("Recent Discord messages synchronized.");
    } catch (error) {
        console.error("Could not synchronize recent messages:", error.message);
    }
});

discord.on("messageCreate", async (message) => {
    try {
        await saveMessage(message);
    } catch (error) {
        console.error("Message processing failed:", error.message);
    }
});

discord.on("error", (error) => {
    console.error("Discord client error:", error.message);
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

// Temporary password test only; this does not create a login session.
app.post("/login", (req, res) => {
    const { password } = req.body || {};

    if (
        typeof password !== "string" ||
        password.length > 200 ||
        password !== process.env.CHAT_PASSWORD
    ) {
        return res.status(401).json({ error: "Incorrect password" });
    }

    res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});
