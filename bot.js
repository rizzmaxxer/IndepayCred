"use strict";

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  console.error('In PowerShell, set it with: $env:TELEGRAM_BOT_TOKEN="<your_token>"');
  process.exit(1);
}

const DATA_DIR = __dirname;
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const LOCK_PATH = path.join(DATA_DIR, "credentials.lock");

// Bot init
const bot = new TelegramBot(TOKEN, { polling: true });

// In-memory state
const awaitingEmail = new Set();

// Helpers
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function ensureFile(filePath, initialJson) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (_) {
    await fs.promises.writeFile(filePath, JSON.stringify(initialJson, null, 2), "utf8");
  }
}

async function readJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmp, filePath);
}

async function withFileLock(fn) {
  for (let i = 0; i < 50; i++) {
    try {
      const handle = await fs.promises.open(LOCK_PATH, "wx");
      try {
        const result = await fn();
        return result;
      } finally {
        await handle.close();
        await fs.promises.unlink(LOCK_PATH).catch(() => {});
      }
    } catch (err) {
      if (err && err.code === "EEXIST") {
        await sleep(200);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not acquire assignment lock. Please try again.");
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

async function getOrCreateUsers() {
  await ensureFile(USERS_PATH, {});
  return readJson(USERS_PATH);
}

async function assignUniqueCredential(userId) {
  return withFileLock(async () => {
    const users = await getOrCreateUsers();
    if (users[userId]) {
      return { already: true, assignment: users[userId] };
    }

    const creds = await readJson(CREDENTIALS_PATH);
    const available = [];

    for (const [uname, value] of Object.entries(creds)) {
      if (typeof value === "string") {
        available.push({ username: uname, password: value });
      } else if (value && typeof value === "object" && !value.assigned) {
        available.push({ username: uname, password: value.password });
      }
    }

    if (available.length === 0) {
      return { noneLeft: true };
    }

    const pick = available[Math.floor(Math.random() * available.length)];

    creds[pick.username] = {
      password: pick.password,
      assigned: true,
      assignedTo: String(userId),
      assignedAt: new Date().toISOString(),
    };

    users[userId] = {
      username: pick.username,
      password: pick.password,
      claimedAt: new Date().toISOString(),
    };

    await writeJson(CREDENTIALS_PATH, creds);
    await writeJson(USERS_PATH, users);

    return { already: false, assignment: users[userId] };
  });
}

async function getUserAssignment(userId) {
  const users = await getOrCreateUsers();
  return users[userId] || null;
}

function formatAssignmentMessage(assignment) {
  return [
    "Here are your credentials:",
    `Username: ${assignment.username}`,
    `Password: ${assignment.password}`,
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
    await bot.sendMessage(chatId, "You’ve already claimed your account. Press My ID to view your credentials.", myIdOnlyKeyboard());
    return;
  }

  const welcome = [
    "Welcome to NorexPay Bot!",
    "- Press Start to claim your unique account.",
    "- Press My ID to view your assigned credentials.",
  ].join("\n");
  await bot.sendMessage(chatId, welcome, mainMenuKeyboard());
});

bot.onText(/\/myid/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const assignment = await getUserAssignment(userId);
  if (!assignment) {
    await bot.sendMessage(chatId, "You don’t have an account yet. Press Start to claim one.", mainMenuKeyboard());
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
      await bot.sendMessage(chatId, "You’ve already claimed your account. Press My ID to view your credentials.", myIdOnlyKeyboard());
      return bot.answerCallbackQuery(query.id);
    }

    awaitingEmail.add(userId);
    await bot.sendMessage(chatId, "Please enter your email address to proceed.");
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "myid") {
    const assignment = await getUserAssignment(userId);
    if (!assignment) {
      await bot.sendMessage(chatId, "You don’t have an account yet. Press Start to claim one.", mainMenuKeyboard());
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
    const result = await assignUniqueCredential(userId);

    if (result.already) {
      await bot.sendMessage(chatId, [
        "You’ve already claimed your account.",
        "",
        formatAssignmentMessage(result.assignment),
      ].join("\n"), myIdOnlyKeyboard());
      return;
    }

    if (result.noneLeft) {
      await bot.sendMessage(chatId, "Sorry, all accounts have been assigned.", mainMenuKeyboard());
      return;
    }

    await bot.sendMessage(chatId, [
      "Success! Your account has been assigned.",
      "",
      formatAssignmentMessage(result.assignment),
    ].join("\n"), myIdOnlyKeyboard());
  } catch (err) {
    console.error("Assignment error:", err);
    await bot.sendMessage(chatId, "An error occurred while assigning your account. Please try again.", mainMenuKeyboard());
  }
});

console.log("NorexPay bot is running. Use /start to begin.");

// Render ws
const app = express();
app.get("/", (req, res) => {
  res.send("Bot is running");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web service running on port ${PORT}`);
});
