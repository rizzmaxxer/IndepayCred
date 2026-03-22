"use strict";

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { promisify } = require("util");

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

// Use Render's free persistent disk
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "bot_data.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Created data directory at ${DATA_DIR}`);
}

// Initialize SQLite database
const db = new sqlite3.Database(DB_PATH);
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

// init
const bot = new TelegramBot(TOKEN, { polling: true });

// In-memory state
const awaitingEmail = new Set();

async function initDatabase() {
  // Create users table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `);

  // Create credentials table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS credentials (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      assigned INTEGER DEFAULT 0,
      assigned_to INTEGER,
      assigned_at TEXT
    )
  `);

  // Check if credentials table is empty, if so, populate it
  const count = await dbGet("SELECT COUNT(*) as count FROM credentials");
  if (count.count === 0) {
    console.log("Populating credentials table with sample data...");
    const sampleCredentials = [
      ["user1@example.com", "pass123"],
      ["user2@example.com", "pass456"],
      ["user3@example.com", "pass789"],
      ["user4@example.com", "passabc"],
      ["user5@example.com", "passdef"],
    ];

    for (const [username, password] of sampleCredentials) {
      await dbRun(
        "INSERT INTO credentials (username, password, assigned) VALUES (?, ?, 0)",
        [username, password]
      );
    }
    console.log("Sample credentials added");
  }
}

async function getUserAssignment(userId) {
  const user = await dbGet("SELECT * FROM users WHERE user_id = ?", [userId]);
  return user || null;
}

async function getUserByEmail(email) {
  const user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
  return user || null;
}

async function assignUniqueCredential(userId, email) {
  // First check if user already has an assignment
  const existingUser = await getUserAssignment(userId);
  if (existingUser) {
    return { already: true, assignment: existingUser };
  }

  // Check if email is already used
  const existingEmail = await getUserByEmail(email);
  if (existingEmail) {
    return { emailUsed: true };
  }

  // Find available credential
  const availableCred = await dbGet(
    "SELECT * FROM credentials WHERE assigned = 0 LIMIT 1"
  );

  if (!availableCred) {
    return { noneLeft: true };
  }

  const now = new Date().toISOString();

  // Update credentials table
  await dbRun(
    `UPDATE credentials 
     SET assigned = 1, assigned_to = ?, assigned_at = ?
     WHERE username = ?`,
    [userId, now, availableCred.username]
  );

  // Add user record
  await dbRun(
    "INSERT INTO users (user_id, username, password, email, claimed_at) VALUES (?, ?, ?, ?, ?)",
    [userId, availableCred.username, availableCred.password, email, now]
  );

  const assignment = {
    user_id: userId,
    username: availableCred.username,
    password: availableCred.password,
    email: email,
    claimed_at: now
  };

  return { already: false, assignment };
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).trim());
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Start", callback_data: "start" }],
        [{ text: "My ID", callback_data: "myid" }],
      ],
    },
  };
}

function myIdOnlyKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "My ID", callback_data: "myid" }]],
    },
  };
}

function formatAssignmentMessage(assignment) {
  return [
    "Here are your credentials:",
    `Username: ${assignment.username}`,
    `Password: ${assignment.password}`,
    `Email: ${assignment.email}`,
    "",
    "Keep them safe. You can always press My ID to view them again.",
  ].join("\n");
}

// Handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const existing = await getUserAssignment(userId);
  if (existing) {
    await bot.sendMessage(chatId, "You've already claimed your id. Press My ID to view your credentials.", myIdOnlyKeyboard());
    return;
  }

  const welcome = [
    "Welcome to Indepay Bot!",
    "- Press Start to get your id.",
    "- Press My ID to view your assigned credentials.",
  ].join("\n");
  await bot.sendMessage(chatId, welcome, mainMenuKeyboard());
});

bot.onText(/\/myid/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const assignment = await getUserAssignment(userId);
  if (!assignment) {
    await bot.sendMessage(chatId, "You don't have an id yet. Press Start to claim one.", mainMenuKeyboard());
    return;
  }
  await bot.sendMessage(chatId, formatAssignmentMessage(assignment), myIdOnlyKeyboard());
});

bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (data === "start") {
    const existing = await getUserAssignment(userId);
    if (existing) {
      await bot.sendMessage(chatId, "You've already claimed your id. Press My ID to view your credentials.", myIdOnlyKeyboard());
      return bot.answerCallbackQuery(query.id);
    }

    awaitingEmail.add(userId);
    await bot.sendMessage(chatId, "Please enter your email address to proceed.");
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "myid") {
    const assignment = await getUserAssignment(userId);
    if (!assignment) {
      await bot.sendMessage(chatId, "You don't have an id yet. Press Start to claim one.", mainMenuKeyboard());
    } else {
      await bot.sendMessage(chatId, formatAssignmentMessage(assignment), myIdOnlyKeyboard());
    }
    return bot.answerCallbackQuery(query.id);
  }
});

bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!awaitingEmail.has(userId)) return;

  const email = (msg.text || "").trim();
  if (!isValidEmail(email)) {
    await bot.sendMessage(chatId, "Invalid email format. Please enter a valid email address.");
    return;
  }

  awaitingEmail.delete(userId);

  try {
    const result = await assignUniqueCredential(userId, email);

    if (result.already) {
      await bot.sendMessage(chatId, [
        "You've already claimed your id.",
        "",
        formatAssignmentMessage(result.assignment),
      ].join("\n"), myIdOnlyKeyboard());
      return;
    }

    if (result.emailUsed) {
      await bot.sendMessage(chatId, "This email has already been used to claim credentials. Please use a different email address.", mainMenuKeyboard());
      return;
    }

    if (result.noneLeft) {
      await bot.sendMessage(chatId, "Sorry, all id's have been assigned.", mainMenuKeyboard());
      return;
    }

    await bot.sendMessage(chatId, [
      "Success! Your id has been assigned.",
      "",
      formatAssignmentMessage(result.assignment),
    ].join("\n"), myIdOnlyKeyboard());
  } catch (err) {
    console.error("Assignment error:", err);
    await bot.sendMessage(chatId, "An error occurred while assigning your id. Please try again.", mainMenuKeyboard());
  }
});

// Initialize database and start the bot
initDatabase().then(() => {
  console.log(`Database initialized at ${DB_PATH}`);
  console.log("Indepay bot is running. Use /start to begin.");
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

// Web service for Render
const app = express();
app.get("/", (req, res) => {
  res.send("Bot is running");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing database connection...');
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Closing database connection...');
  await db.close();
  process.exit(0);
});
