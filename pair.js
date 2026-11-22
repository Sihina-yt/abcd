const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const router = express.Router();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const FIREBASE_URL = 'https://sakura-xd-default-rtdb.asia-southeast1.firebasedatabase.app/';
const SESSION_BASE_PATH = './session';
const activeSockets = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });

async function EmpirePair(number, res) {
    const clean = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${clean}`);
    try {
        const r = await axios.get(`${FIREBASE_URL}/session/creds_${clean}.json`);
        if (r.data) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(r.data));
        }
    } catch {}
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });
    const socket = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Safari')
    });
    if (!socket.authState.creds.registered) {
        await delay(1500);
        const code = await socket.requestPairingCode(clean);
        if (!res.headersSent) res.send({ code });
    }
    socket.ev.on('creds.update', async () => {
        await saveCreds();
        const c = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
        await axios.put(`${FIREBASE_URL}/session/creds_${clean}.json`, JSON.parse(c));
    });
    socket.ev.on('connection.update', async (u) => {
        if (u.connection === 'open') {
            activeSockets.set(clean, socket);
            await delay(2000);
            await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: `*MIZU-MD*\n\n✅ Successfully connected!\n\n🔢 Number: ${clean}` });
        }
        if (u.connection === 'close') {
            activeSockets.delete(clean);
        }
    });
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    await EmpirePair(number, res);
});
router.get('/code', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    await EmpirePair(number, res);
});
router.get('/ping', (req, res) => res.send({ status: 'active', message: 'MIZU-MD is running' }));
router.get('/health', (req, res) => res.send({ status: 'ok' }));

module.exports = router;
