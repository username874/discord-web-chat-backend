require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// Render runs behind a proxy.
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));

const requiredEnv = [
    "DISCORD_TOKEN",
    "DISCORD_CHANNEL_ID",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CHAT_PASSWORD",
    "FRONTEND_ORIGIN"
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`Missing environment variable: ${key}`);
        process.exit(1);
    }
}

const frontendOrigin = process.env.FRONTEND_ORIGIN
    .trim()
    .replace(/\/+$/, "");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Temporary in-memory sessions. Sessions expire after 12 hours.
const sessions = new Map();
const loginAttempts = new Map();
const messageAttempts = new Map();

const SESSION_DURATION = 12 * 60 * 60 * 1000;
const MESSAGE_WINDOW = 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 8;

// CORS configuration.
app.use((req, res, next) => {
    const origin = req.headers.origin;

    console.log("CORS check:", {
        requestOrigin: origin,
        configuredOrigin: frontendOrigin,
        method: req.method
    });

    res.setHeader("Vary", "Origin");

    if (origin && origin !== frontendOrigin) {
        return res.status(403).json({
            error: "Origin not allowed"
        });
    }

    if (origin === frontendOrigin) {
        res.setHeader(
            "Access-Control-Allow-Origin",
            frontendOrigin
        );
    }

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

// Discord bot.
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Remove messages older than five minutes.
async function removeOldMessages() {
    const cutoff = new Date(
        Date.now() - 5 * 60 * 1000
    ).toISOString();

    const { error } = await supabase
        .from("messages")
        .delete()
        .lt("created_at", cutoff);

    if (error) {
        console.error(
            "Could not remove old messages:",
            error.message
        );
    }
}

// Save a Discord message, including image attachments.
async function saveMessage(message) {
    if (message.channelId !== process.env.DISCORD_CHANNEL_ID) {
        return;
    }

    if (message.author.system) {
        return;
    }

    const attachments = Array.from(
        message.attachments.values()
    )
        .filter((attachment) =>
            attachment.contentType?.startsWith("image/")
        )
        .map((attachment) => ({
            url: attachment.url,
            name: attachment.name,
            contentType: attachment.contentType
        }));

    // Ignore messages that contain neither text nor images.
    if (
        !message.content.trim() &&
        attachments.length === 0
    ) {
        return;
    }

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
                attachments: attachments,
                created_at: message.createdAt.toISOString()
            },
            {
                onConflict: "discord_message_id"
            }
        );

    if (error) {
        console.error(
            "Could not save Discord message:",
            error.message
        );
    } else {
        await removeOldMessages();
    }
}

// Rate-limit requests.
function limitRequests(store, key, max, windowMs) {
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
        entry = {
            count: 0,
            resetAt: now + windowMs
        };
    }

    entry.count++;
    store.set(key, entry);

    if (entry.count > max) {
        return Math.max(
            1,
            Math.ceil((entry.resetAt - now) / 1000)
        );
    }

    return 0;
}

// Require a valid login session.
function requireSession(req, res, next) {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer ([a-f0-9]{64})$/i);

    if (!match) {
        return res.status(401).json({
            error: "Please log in first"
        });
    }

    const token = match[1];
    const session = sessions.get(token);

    if (!session || Date.now() >= session.expiresAt) {
        sessions.delete(token);

        return res.status(401).json({
            error: "Session expired. Log in again."
        });
    }

    req.sessionToken = token;
    next();
}

// Synchronize recent Discord messages when the bot starts.
discord.once("ready", async () => {
    console.log(
        `Discord bot logged in as ${discord.user.tag}`
    );

    try {
        const channel = await discord.channels.fetch(
            process.env.DISCORD_CHANNEL_ID
        );

        if (
            !channel ||
            !channel.isTextBased() ||
            !channel.messages
        ) {
            console.error(
                "Configured channel is not a readable text channel."
            );
            return;
        }

        const recentMessages = await channel.messages.fetch({
            limit: 100
        });

        const cutoff = Date.now() - 5 * 60 * 1000;

        for (const message of recentMessages.values()) {
            if (message.createdTimestamp >= cutoff) {
                await saveMessage(message);
            }
        }

        await removeOldMessages();

        console.log(
            "Recent Discord messages synchronized."
        );
    } catch (error) {
        console.error(
            "Could not synchronize messages:",
            error.message
        );
    }
});

// Save newly created Discord messages.
discord.on("messageCreate", async (message) => {
    try {
        await saveMessage(message);
    } catch (error) {
        console.error(
            "Message processing failed:",
            error.message
        );
    }
});

discord.on("error", (error) => {
    console.error(
        "Discord client error:",
        error.message
    );
});

discord.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error(
        "Discord login failed:",
        error.message
    );
});

// Basic health check.
app.get("/", (req, res) => {
    res.send("Private Discord Chat backend is running!");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        discordReady: discord.isReady()
    });
});

// Log in with the shared password.
app.post("/login", (req, res) => {
    const retryAfter = limitRequests(
        loginAttempts,
        req.ip,
        10,
        15 * 60 * 1000
    );

    if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));

        return res.status(429).json({
            error: "Too many login attempts. Try again later."
        });
    }

    const { password } = req.body || {};

    if (
        typeof password !== "string" ||
        password.length > 200 ||
        password.length !== process.env.CHAT_PASSWORD.length
    ) {
        return res.status(401).json({
            error: "Incorrect password"
        });
    }

    const supplied = Buffer.from(password, "utf8");
    const expected = Buffer.from(
        process.env.CHAT_PASSWORD,
        "utf8"
    );

    if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
    ) {
        return res.status(401).json({
            error: "Incorrect password"
        });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_DURATION;

    sessions.set(token, { expiresAt });

    res.json({
        token,
               expiresAt: new Date(expiresAt).toISOString()
    });
});

// Read messages from the last five minutes.
app.get("/api/messages", requireSession, async (req, res) => {
    try {
        await removeOldMessages();

        const cutoff = new Date(
            Date.now() - 5 * 60 * 1000
        ).toISOString();

        const { data, error } = await supabase
            .from("messages")
            .select("id, sender, content, attachments, created_at")
            .gte("created_at", cutoff)
            .order("created_at", { ascending: true })
            .limit(200);

        if (error) {
            console.error("Could not read messages:", error.message);
            return res.status(500).json({
                error: "Could not load messages"
            });
        }

        res.json({ messages: data });
    } catch (error) {
        console.error("Message retrieval failed:", error.message);
        res.status(500).json({
            error: "Could not load messages"
        });
    }
});

// Send a message to Discord as the bot.
app.post("/api/messages", requireSession, async (req, res) => {
    const retryAfter = limitRequests(
        messageAttempts,
        req.sessionToken,
        MAX_MESSAGES_PER_WINDOW,
        MESSAGE_WINDOW
    );

    if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
            error: "You're sending messages too quickly. Please wait."
        });
    }

    const { content } = req.body || {};

    if (typeof content !== "string") {
        return res.status(400).json({
            error: "Message text is required"
        });
    }

    const trimmed = content.trim();

    if (!trimmed) {
        return res.status(400).json({
            error: "Message cannot be empty"
        });
    }

    if (trimmed.length > 1500) {
        return res.status(400).json({
            error: "Messages must be 1500 characters or fewer"
        });
    }

    try {
        const channel = await discord.channels.fetch(
            process.env.DISCORD_CHANNEL_ID
        );

        if (!channel || !channel.isTextBased() || !channel.send) {
            return res.status(503).json({
                error: "Discord channel is unavailable"
            });
        }

        const sentMessage = await channel.send({
            content: trimmed,
            allowedMentions: { parse: [] }
        });

        // Save immediately, even if the bot's message event is delayed.
        await saveMessage(sentMessage);

        res.status(201).json({
            message: {
                sender: discord.user.username,
                content: sentMessage.content,
                attachments: [],
                created_at: sentMessage.createdAt.toISOString()
            }
        });
    } catch (error) {
        console.error("Could not send Discord message:", error.message);
        res.status(500).json({
            error: "Could not send message to Discord"
        });
    }
});

// Expire old sessions and limiters periodically.
setInterval(() => {
    const now = Date.now();

    for (const [token, session] of sessions) {
        if (now >= session.expiresAt) {
            sessions.delete(token);
        }
    }

    for (const store of [loginAttempts, messageAttempts]) {
        for (const [key, entry] of store) {
            if (now >= entry.resetAt) {
                store.delete(key);
            }
        }
    }

    removeOldMessages().catch((error) => {
        console.error("Message cleanup failed:", error.message);
    });
}, 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});
