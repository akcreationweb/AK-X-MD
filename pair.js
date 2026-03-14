const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  DisconnectReason
} = require('dct-dula-baileys');

// ───────────────────────────────────────────────
//  CONFIG
// ───────────────────────────────────────────────

const BOT_NAME   = 'AK X MD';
const PREFIX     = process.env.PREFIX || '.';
const OWNER_NUM  = process.env.OWNER_NUMBER || '94700000000';
const BOT_IMG    = process.env.BOT_IMAGE   || 'https://files.catbox.moe/p2f8x0.jpg';
const BOT_VER    = '1.0.0';

// ───────────────────────────────────────────────
//  MONGODB
// ───────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI || '';
const MONGO_DB  = process.env.MONGO_DB  || 'AK_X_MD';

let mongoClient, mongoDB;
let sessionsCol, numbersCol;

async function initMongo() {
  if (!MONGO_URI) throw new Error('MONGO_URI not set');
  if (mongoClient) {
    try { if (mongoClient.topology?.isConnected()) return; } catch(e) {}
  }
  mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  mongoDB    = mongoClient.db(MONGO_DB);
  sessionsCol = mongoDB.collection('sessions');
  numbersCol  = mongoDB.collection('numbers');
  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 },  { unique: true });
  console.log('✅ MongoDB connected');
}

async function saveCredsToMongo(number, creds) {
  try {
    await initMongo();
    const n = number.replace(/[^0-9]/g, '');
    await sessionsCol.updateOne({ number: n }, { $set: { number: n, creds, updatedAt: new Date() } }, { upsert: true });
  } catch (e) { console.error('saveCredsToMongo:', e.message); }
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const n = number.replace(/[^0-9]/g, '');
    return await sessionsCol.findOne({ number: n });
  } catch (e) { return null; }
}

async function addNumber(number) {
  try {
    await initMongo();
    const n = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: n }, { $set: { number: n } }, { upsert: true });
  } catch (e) {}
}

async function removeNumber(number) {
  try {
    await initMongo();
    const n = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: n });
    await sessionsCol.deleteOne({ number: n });
  } catch (e) {}
}

async function getAllNumbers() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { return []; }
}

// ───────────────────────────────────────────────
//  UTILS
// ───────────────────────────────────────────────

function sriLankaTime() {
  return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Fake Meta contact for "mentioned by" style quoted messages
function metaQuote(label = BOT_NAME) {
  return {
    key: {
      remoteJid: 'status@broadcast',
      participant: '0@s.whatsapp.net',
      fromMe: false,
      id: `AK_X_MD_${Date.now()}`
    },
    message: {
      contactMessage: {
        displayName: label,
        vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${label};;;;\nFN:${label}\nORG:AK X MD\nTEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002\nEND:VCARD`
      }
    }
  };
}

// ───────────────────────────────────────────────
//  ACTIVE SESSIONS
// ───────────────────────────────────────────────

const activeSockets     = new Map();
const socketCreatedAt   = new Map();

// ───────────────────────────────────────────────
//  STATUS / AUTO-VIEW  (minimal - kept simple)
// ───────────────────────────────────────────────

function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.key || msg.key.remoteJid !== 'status@broadcast' || !msg.key.participant) return;
    try {
      await socket.readMessages([msg.key]);
    } catch (e) {}
  });
}

// ───────────────────────────────────────────────
//  COMMAND HANDLER  —  only .menu  and  .ping
// ───────────────────────────────────────────────

function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return;

    // Unwrap ephemeral
    if (getContentType(msg.message) === 'ephemeralMessage') {
      msg.message = msg.message.ephemeralMessage.message;
    }

    const type = getContentType(msg.message);
    const from = msg.key.remoteJid;
    const nowsender = msg.key.fromMe
      ? (socket.user.id.split(':')[0] + '@s.whatsapp.net')
      : (msg.key.participant || msg.key.remoteJid);
    const senderNum = nowsender.split('@')[0];
    const botNum    = socket.user.id.split(':')[0];
    const isOwner   = senderNum === OWNER_NUM.replace(/[^0-9]/g,'') || senderNum === botNum;

    // Extract body text
    const body =
      type === 'conversation'         ? msg.message.conversation :
      type === 'extendedTextMessage'  ? msg.message.extendedTextMessage.text :
      (type === 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption :
      (type === 'videoMessage' && msg.message.videoMessage.caption) ? msg.message.videoMessage.caption : '';

    if (!body || typeof body !== 'string') return;
    if (!body.startsWith(PREFIX)) return;

    const command = body.slice(PREFIX.length).trim().split(' ').shift().toLowerCase();
    const args    = body.trim().split(/ +/).slice(1);

    // ── reply helper ──────────────────────────────
    const reply = (text) => socket.sendMessage(from, { text }, { quoted: msg });

    try {
      switch (command) {

        // ════════════════════════════════════════
        //  .menu
        // ════════════════════════════════════════
        case 'menu': {
          try { await socket.sendMessage(from, { react: { text: '🗒️', key: msg.key } }); } catch(e) {}

          const startTime = socketCreatedAt.get(number) || Date.now();
          const upSec     = Math.floor((Date.now() - startTime) / 1000);
          const h = Math.floor(upSec / 3600);
          const m = Math.floor((upSec % 3600) / 60);
          const s = Math.floor(upSec % 60);

          const quote = metaQuote();

          const text = `
*⚔️ AK X MD — BOT MENU ⚔️*

*╭─「 𝐁ot 𝐈nfo 」──●●➤*
*│ 🤖 𝐁ot 𝐍ame :* ${BOT_NAME}
*│ 🔣 𝐏refix :* ${PREFIX}
*│ 📦 𝐕ersion :* ${BOT_VER}
*│ ⏳ 𝐔ptime :* ${h}h ${m}m ${s}s
*│ 🕒 𝐓ime :* ${sriLankaTime()}
*╰────────────●●➤*

*╭─「 𝐂ommands 」──●●➤*
*│ ${PREFIX}menu* — Show this menu
*│ ${PREFIX}ping* — Check bot speed
*╰────────────●●➤*

> *⚔️ AK X MD*
`.trim();

          await socket.sendMessage(from, {
            image: { url: BOT_IMG },
            caption: text,
            footer: '⚔️ AK X MD',
            buttons: [
              { buttonId: `${PREFIX}ping`, buttonText: { displayText: '📡 PING' }, type: 1 }
            ],
            headerType: 4
          }, { quoted: quote });
          break;
        }

        // ════════════════════════════════════════
        //  .ping
        // ════════════════════════════════════════
        case 'ping': {
          try { await socket.sendMessage(from, { react: { text: '📡', key: msg.key } }); } catch(e) {}

          const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
          const quote   = metaQuote();

          await socket.sendMessage(from, {
            image: { url: BOT_IMG },
            caption: `*📡 AK X MD — PING*\n\n*🏓 Latency :* ${latency}ms\n*🕒 Time :* ${sriLankaTime()}\n\n> *⚔️ AK X MD*`,
            footer: '⚔️ AK X MD',
            buttons: [
              { buttonId: `${PREFIX}menu`, buttonText: { displayText: '📄 MENU' }, type: 1 }
            ],
            headerType: 4
          }, { quoted: quote });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error(`Command error [${command}]:`, err.message);
      try { await reply(`❌ Error: ${err.message}`); } catch(e) {}
    }
  });
}

// ───────────────────────────────────────────────
//  AUTO-RESTART ON DISCONNECT
// ───────────────────────────────────────────────

function setupAutoRestart(socket, number) {
  socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode
              || lastDisconnect?.error?.statusCode;
    const isLoggedOut =
      code === 401 ||
      String(lastDisconnect?.error || '').toLowerCase().includes('logged out');

    if (isLoggedOut) {
      console.log(`[${number}] Logged out — cleaning up`);
      await removeNumber(number);
      activeSockets.delete(number);
      socketCreatedAt.delete(number);
    } else {
      console.log(`[${number}] Disconnected — reconnecting in 10s…`);
      setTimeout(async () => {
        activeSockets.delete(number);
        socketCreatedAt.delete(number);
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        await startSession(number, mockRes).catch(e => console.error('Reconnect failed:', e));
      }, 10000);
    }
  });
}

// ───────────────────────────────────────────────
//  MAIN SESSION STARTER
// ───────────────────────────────────────────────

async function startSession(number, res) {
  const n           = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `ak_session_${n}`);

  await initMongo().catch(() => {});

  // Pre-fill creds from Mongo if available
  try {
    const doc = await loadCredsFromMongo(n);
    if (doc?.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(
        path.join(sessionPath, 'creds.json'),
        JSON.stringify(doc.creds, null, 2)
      );
      console.log(`[${n}] Loaded creds from MongoDB`);
    }
  } catch (e) { console.warn('Prefill creds failed:', e.message); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'silent' });

  try {
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    socketCreatedAt.set(n, Date.now());

    // Setup all handlers
    setupStatusHandlers(socket);
    setupCommandHandlers(socket, n);
    setupAutoRestart(socket, n);

    // Request pairing code if not yet registered
    if (!socket.authState.creds.registered) {
      let retries = 3;
      let code;
      while (retries-- > 0) {
        try {
          await delay(1500);
          code = await socket.requestPairingCode(n);
          break;
        } catch (e) {
          await delay(2000);
        }
      }
      if (!res.headersSent) res.send({ code: code || 'ERROR' });
    }

    // Save creds to Mongo on update
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const credsPath = path.join(sessionPath, 'creds.json');
        if (!fs.existsSync(credsPath)) return;
        const content = fs.readFileSync(credsPath, 'utf8').trim();
        if (!content || content === '{}' || content === 'null') return;
        const credsObj = JSON.parse(content);
        if (credsObj && typeof credsObj === 'object') {
          await saveCredsToMongo(n, credsObj);
        }
      } catch (e) { console.error('creds.update error:', e.message); }
    });

    // On connected
    socket.ev.on('connection.update', async ({ connection }) => {
      if (connection !== 'open') return;
      try {
        await delay(2000);
        const userJid = jidNormalizedUser(socket.user.id);
        activeSockets.set(n, socket);
        await addNumber(n);

        // Welcome message to bot user
        await socket.sendMessage(userJid, {
          image: { url: BOT_IMG },
          caption: `*⚔️ AK X MD — CONNECTED ✅*\n\n*📞 Number :* ${n}\n*🕒 Time :* ${sriLankaTime()}\n\nType *${PREFIX}menu* to get started!\n\n> *⚔️ AK X MD*`
        });
      } catch (e) { console.error('connection.open error:', e.message); }
    });

    activeSockets.set(n, socket);

  } catch (err) {
    console.error(`startSession error [${n}]:`, err.message);
    socketCreatedAt.delete(n);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
}

// ───────────────────────────────────────────────
//  EXPRESS ROUTES
// ───────────────────────────────────────────────

// Pair / get pairing code
router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'number required' });
  const n = number.replace(/[^0-9]/g, '');
  if (activeSockets.has(n)) return res.send({ status: 'already_connected' });
  await startSession(number, res);
});

// Health check
router.get('/ping', (req, res) => {
  res.send({
    status: 'active',
    bot: BOT_NAME,
    activeSessions: activeSockets.size,
    time: sriLankaTime()
  });
});

// Active sessions list
router.get('/active', (req, res) => {
  res.send({
    bot: BOT_NAME,
    count: activeSockets.size,
    numbers: Array.from(activeSockets.keys()),
    time: sriLankaTime()
  });
});

// Reconnect all saved sessions
router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbers();
    if (!numbers.length) return res.status(404).send({ error: 'No sessions in DB' });
    const results = [];
    for (const n of numbers) {
      if (activeSockets.has(n)) { results.push({ n, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await startSession(n, mockRes).catch(e => {});
      results.push({ n, status: 'initiated' });
      await delay(800);
    }
    res.send({ status: 'ok', results });
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

// ───────────────────────────────────────────────
//  STARTUP — auto reconnect saved sessions
// ───────────────────────────────────────────────

initMongo()
  .then(async () => {
    const nums = await getAllNumbers();
    for (const n of nums) {
      if (!activeSockets.has(n)) {
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        await startSession(n, mockRes).catch(e => console.error('Auto-reconnect failed:', e.message));
        await delay(800);
      }
    }
  })
  .catch(e => console.warn('MongoDB startup init failed:', e.message));

module.exports = router;
