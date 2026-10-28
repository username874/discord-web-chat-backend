require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
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
const memberLookups = new Map();

const SESSION_DURATION = 12 * 60 * 60 * 1000;
const MESSAGE_WINDOW = 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 8;

// Direct messages are kept for 24 hours (change this to keep them longer or shorter).
const DM_RETENTION_MS = 24 * 60 * 60 * 1000;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

// Image upload settings.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB (safe under Discord's bot limit)
const MAX_IMAGES = 4;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES }
});

// Check the real file signature instead of trusting the client's MIME type.
function detectImageExtension(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
    if (
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
    ) return "webp";
    return null;
}

function parseUpload(req, res, next) {
    upload.array("images", MAX_IMAGES)(req, res, (error) => {
        if (!error) return next();

        const message = error.code === "LIMIT_FILE_SIZE"
            ? "Each image must be 8 MB or smaller"
            : error.code === "LIMIT_UNEXPECTED_FILE" || error.code === "LIMIT_FILE_COUNT"
                ? `You can attach up to ${MAX_IMAGES} images`
                : "Upload failed";

        res.status(400).json({ error: message });
    });
}

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
// GuildMembers is a privileged intent: enable "Server Members Intent" for the
// bot in the Discord Developer Portal, or the bot will fail to log in.
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    // Required so the bot receives DM channels it hasn't cached yet.
    partials: [Partials.Channel]
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

// Remove direct messages older than the retention period.
async function removeOldDms() {
    const cutoff = new Date(
        Date.now() - DM_RETENTION_MS
    ).toISOString();

    const { error } = await supabase
        .from("dms")
        .delete()
        .lt("created_at", cutoff);

    if (error) {
        console.error(
            "Could not remove old DMs:",
            error.message
        );
    }
}

function inferImageContentType(url = "") {
    const path = url.split(/[?#]/)[0].toLowerCase();

    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".avif")) return "image/avif";

    return "image/*";
}

// Save Discord messages, including image attachments and GIF embeds.
async function saveMessage(message) {
    if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;
    if (message.author.system) return;

    const attachments = Array.from(message.attachments.values())
        .filter((attachment) =>
            attachment.contentType?.toLowerCase().startsWith("image/") ||
            /\.(gif|png|jpe?g|webp|avif)(?:$|[?#])/i.test(attachment.url || "")
        )
        .map((attachment) => ({
            url: attachment.url,
            name: attachment.name || "Image attachment",
            contentType: attachment.contentType || inferImageContentType(attachment.url)
        }));

    for (const embed of message.embeds || []) {
        const imageUrl =
            embed.image?.url ||
            embed.thumbnail?.url ||
            embed.video?.url;

        if (typeof imageUrl === "string" && imageUrl.startsWith("https://")) {
            attachments.push({
                url: imageUrl,
                name: "Discord GIF or image",
                contentType: inferImageContentType(imageUrl)
            });
        }

        const embedUrl = embed.url;

        if (
            typeof embedUrl === "string" &&
            embedUrl.startsWith("https://") &&
            /(?:klipy|tenor|giphy)/i.test(embedUrl) &&
            /\.(gif|png|jpe?g|webp)(?:$|[?#])/i.test(embedUrl)
        ) {
            attachments.push({
                url: embedUrl,
                name: "GIF",
                contentType: inferImageContentType(embedUrl)
            });
        }
    }

    const uniqueAttachments = [
        ...new Map(attachments.map((item) => [item.url, item])).values()
    ];

    if (
        !message.content.trim() &&
        uniqueAttachments.length === 0 &&
        (!message.embeds || message.embeds.length === 0)
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
                avatar_url: message.author.displayAvatarURL({
                    size: 128
                }),
                content: message.content,
                attachments: uniqueAttachments,
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

// The server (guild) that the chat channel belongs to.
async function getGuild() {
    const channel = await discord.channels.fetch(
        process.env.DISCORD_CHANNEL_ID
    );

    return channel?.guild || null;
}

// Only people who are members of the server can be messaged.
async function getGuildMember(userId) {
    const guild = await getGuild();
    if (!guild) return null;

    try {
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

// Save a DM that someone sent to the bot (only from server members).
async function saveInboundDm(message) {
    if (message.author.bot || message.author.system) return;

    const member = await getGuildMember(message.author.id);
    if (!member) return;

    const content = message.content?.trim()
        ? message.content
        : message.attachments.size > 0
            ? "[sent an attachment]"
            : "";

    if (!content) return;

    const { error } = await supabase
        .from("dms")
        .upsert(
            {
                discord_message_id: message.id,
                discord_user_id: member.id,
                discord_username: member.displayName,
                avatar_url: member.displayAvatarURL({ size: 128 }),
                direction: "in",
                content,
                created_at: message.createdAt.toISOString()
            },
            { onConflict: "discord_message_id" }
        );

    if (error) {
        console.error("Could not save inbound DM:", error.message);
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

// Save newly created Discord messages (channel messages and DMs to the bot).
discord.on("messageCreate", async (message) => {
    try {
        // Messages with no server are DMs.
        if (!message.guildId) {
            await saveInboundDm(message);
            return;
        }

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
            .select("id, sender, avatar_url, content, attachments, created_at")
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

// Send a message (text and/or images) to Discord as the bot.
app.post("/api/messages", requireSession, parseUpload, async (req, res) => {
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

    const rawContent = req.body?.content;
    const content = typeof rawContent === "string" ? rawContent.trim() : "";
    const uploaded = req.files || [];

    if (!content && uploaded.length === 0) {
        return res.status(400).json({
            error: "Write a message or attach an image"
        });
    }

    if (content.length > 1500) {
        return res.status(400).json({
            error: "Messages must be 1500 characters or fewer"
        });
    }

    const files = [];
    for (const [i, file] of uploaded.entries()) {
        const ext = detectImageExtension(file.buffer);

        if (!ext) {
            return res.status(400).json({
                error: "Only PNG, JPEG, GIF and WebP images are allowed"
            });
        }

        // Never reuse the client's filename.
        files.push({
            attachment: file.buffer,
            name: `image-${Date.now()}-${i}.${ext}`
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
            content: content || undefined,
            files,
            allowedMentions: { parse: [] }
        });

        // Save immediately, even if the bot's message event is delayed.
        await saveMessage(sentMessage);

        res.status(201).json({
            message: {
                sender: discord.user.username,
                content: sentMessage.content,
                attachments: Array.from(sentMessage.attachments.values()).map((a) => ({
                    url: a.url,
                    name: a.name,
                    contentType: a.contentType
                })),
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

// ---------- Direct messages ----------

// Search server members by name, so you can start a DM.
app.get("/api/members", requireSession, async (req, res) => {
    const retryAfter = limitRequests(
        memberLookups,
        req.sessionToken,
        30,
        MESSAGE_WINDOW
    );

    if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
            error: "Searching too quickly. Please wait a moment."
        });
    }

    const query = typeof req.query.q === "string"
        ? req.query.q.trim().slice(0, 32)
        : "";

    if (!query) {
        return res.json({ members: [] });
    }

    try {
        const guild = await getGuild();

        if (!guild) {
            return res.status(503).json({
                error: "Discord server is unavailable"
            });
        }

        const found = await guild.members.fetch({ query, limit: 10 });

        const members = Array.from(found.values())
            .filter((member) => !member.user.bot)
            .map((member) => ({
                id: member.id,
                name: member.displayName,
                username: member.user.username,
                avatar_url: member.displayAvatarURL({ size: 64 })
            }));

        res.json({ members });
    } catch (error) {
        console.error("Could not search members:", error.message);
        res.status(500).json({
            error: "Could not search members"
        });
    }
});

// List DM conversations (one entry per person, newest first).
app.get("/api/dms", requireSession, async (req, res) => {
    try {
        await removeOldDms();

        const { data, error } = await supabase
            .from("dms")
            .select("id, discord_user_id, discord_username, avatar_url, direction, content, created_at")
            .order("created_at", { ascending: false })
            .limit(500);

        if (error) {
            console.error("Could not read DMs:", error.message);
            return res.status(500).json({
                error: "Could not load DMs"
            });
        }

        const conversations = new Map();

        for (const row of data) {
            // Rows are newest first, so the first row per person is the latest.
            if (conversations.has(row.discord_user_id)) continue;

            conversations.set(row.discord_user_id, {
                user_id: row.discord_user_id,
                name: row.discord_username,
                avatar_url: row.avatar_url,
                last_id: row.id,
                last_content: row.content,
                last_direction: row.direction,
                last_at: row.created_at
            });
        }

        res.json({ conversations: Array.from(conversations.values()) });
    } catch (error) {
        console.error("DM list failed:", error.message);
        res.status(500).json({
            error: "Could not load DMs"
        });
    }
});

// Read one DM conversation.
app.get("/api/dms/:userId", requireSession, async (req, res) => {
    const { userId } = req.params;

    if (!DISCORD_ID_PATTERN.test(userId)) {
        return res.status(400).json({
            error: "Invalid user"
        });
    }

    try {
        await removeOldDms();

        const { data, error } = await supabase
            .from("dms")
            .select("id, direction, content, created_at")
            .eq("discord_user_id", userId)
            .order("created_at", { ascending: true })
            .limit(200);

        if (error) {
            console.error("Could not read DM thread:", error.message);
            return res.status(500).json({
                error: "Could not load this conversation"
            });
        }

        res.json({ messages: data });
    } catch (error) {
        console.error("DM thread failed:", error.message);
        res.status(500).json({
            error: "Could not load this conversation"
        });
    }
});

// Send a DM to a server member as the bot.
app.post("/api/dms/:userId", requireSession, async (req, res) => {
    const { userId } = req.params;

    if (!DISCORD_ID_PATTERN.test(userId)) {
        return res.status(400).json({
            error: "Invalid user"
        });
    }

    const retryAfter = limitRequests(
        messageAttempts,
        `dm:${req.sessionToken}`,
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

    if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({
            error: "Message cannot be empty"
        });
    }

    const trimmed = content.trim();

    if (trimmed.length > 1500) {
        return res.status(400).json({
            error: "Messages must be 1500 characters or fewer"
        });
    }

    try {
        const member = await getGuildMember(userId);

        if (!member || member.user.bot) {
            return res.status(404).json({
                error: "That person isn't in the Discord server"
            });
        }

        let sent;

        try {
            sent = await member.user.send({
                content: trimmed,
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            // 50007 = the person doesn't accept DMs from this bot.
            if (error.code === 50007) {
                return res.status(403).json({
                    error: `${member.displayName} has DMs turned off for server members, so the bot can't message them.`
                });
            }

            throw error;
        }

        const { error: dbError } = await supabase
            .from("dms")
            .upsert(
                {
                    discord_message_id: sent.id,
                    discord_user_id: member.id,
                    discord_username: member.displayName,
                    avatar_url: member.displayAvatarURL({ size: 128 }),
                    direction: "out",
                    content: trimmed,
                    created_at: sent.createdAt.toISOString()
                },
                { onConflict: "discord_message_id" }
            );

        if (dbError) {
            console.error("Could not save outbound DM:", dbError.message);
        }

        res.status(201).json({
            message: {
                direction: "out",
                content: trimmed,
                created_at: sent.createdAt.toISOString()
            }
        });
    } catch (error) {
        console.error("Could not send DM:", error.message);
        res.status(500).json({
            error: "Could not send the DM"
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

    for (const store of [loginAttempts, messageAttempts, memberLookups]) {
        for (const [key, entry] of store) {
            if (now >= entry.resetAt) {
                store.delete(key);
            }
        }
    }

    removeOldMessages().catch((error) => {
        console.error("Message cleanup failed:", error.message);
    });

    removeOldDms().catch((error) => {
        console.error("DM cleanup failed:", error.message);
    });
}, 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend server started on port ${PORT}`);
});
