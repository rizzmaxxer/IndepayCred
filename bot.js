"use strict";

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// init
const bot = new TelegramBot(TOKEN, { polling: true });

// In-memory state
const awaitingEmail = new Set();

// Helper functions
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        claimed_at TIMESTAMP NOT NULL
      )
    `);

    // Create credentials table
    await client.query(`
      CREATE TABLE IF NOT EXISTS credentials (
        username VARCHAR(255) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        assigned BOOLEAN DEFAULT FALSE,
        assigned_to BIGINT,
        assigned_at TIMESTAMP
      )
    `);

    // Check if credentials table is empty, if so, populate it
    const result = await client.query("SELECT COUNT(*) FROM credentials");
    if (parseInt(result.rows[0].count) === 0) {
      console.log("Populating credentials table with sample data...");
      const sampleCredentials = [
        ["user1@example.com", "pass123"],
        ["user2@example.com", "pass456"],
        ["user3@example.com", "pass789"],
        ["user4@example.com", "passabc"],
        ["user5@example.com", "passdef"],
      ];

      for (const [username, password] of sampleCredentials) {
        await client.query(
          "INSERT INTO credentials (username, password, assigned) VALUES ($1, $2, $3)",
          [username, password, false]
        );
      }
    }
  } finally {
    client.release();
  }
}

async function getUserAssignment(userId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM users WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getUserByEmail(email) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function assignUniqueCredential(userId, email) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // First check if user already has an assignment
    const existingUser = await client.query(
      "SELECT * FROM users WHERE user_id = $1",
      [userId]
    );
    if (existingUser.rows.length > 0) {
      await client.query("COMMIT");
      return { already: true, assignment: existingUser.rows[0] };
    }

    // Check if email is already used
    const existingEmail = await client.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    if (existingEmail.rows.length > 0) {
      await client.query("COMMIT");
      return { emailUsed: true };
    }

    // Find available credential
    const availableCred = await client.query(
      "SELECT * FROM credentials WHERE assigned = false LIMIT 1 FOR UPDATE"
    );

    if (availableCred.rows.length === 0) {
      await client.query("COMMIT");
      return { noneLeft: true };
    }

    const cred = availableCred.rows[0];
    const now = new Date().toISOString();

    // Update credentials table
    await client.query(
      `UPDATE credentials 
       SET assigned = true, assigned_to = $1, assigned_at = $2
       WHERE username = $3`,
      [userId, now, cred.username]
    );

    // Add user record
    await client.query(
      "INSERT INTO users (user_id, username, password, email, claimed_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, cred.username, cred.password, email, now]
    );

    await client.query("COMMIT");

    const assignment = {
      user_id: userId,
      username: cred.username,
      password: cred.password,
      email: email,
      claimed_at: now
    };

    return { already: false, assignment };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

// Handlers (same as before)
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
  console.log("Database initialized successfully");
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
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Closing database connection...');
  await pool.end();
  process.exit(0);
});
