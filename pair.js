const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./lib/msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const FIREBASE_URL = 'https://sakura-xd-default-rtdb.asia-southeast1.firebasedatabase.app/';

const config = {
    BOT_NAME: 'MIZU-MD',
    BOT_FOOTER: 'ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍɪᴢᴜ ᴍᴅ </>',
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/JrGEc8TBMcrGKs6uB6GP3X?s=cl&p=a&iam=2',
    RCD_IMAGE_PATH: 'https://u.pone.rs/cajvaazh.jpg',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: process.env.OWNER_NUMBER || '94740261896',
    PM2_NAME: process.env.PM2_NAME || 'MIZU-MD-main'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function getSriLankaTimestamp() { return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }
function capital(string) { return string.charAt(0).toUpperCase() + string.slice(1); }
const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);
async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;
        const sessionKeys = Object.keys(data).filter(k => k.startsWith(`empire_${sanitizedNumber}_`) && k.endsWith('.json')).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });
        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
            }
        }
    } catch (e) { console.error(`Clean duplicate failed:`, e.message); }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage('🔐 OTP VERIFICATION', `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`, config.BOT_FOOTER);
    await socket.sendMessage(userJid, { text: message });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;
        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const message = formatMessage('🗑️ MESSAGE DELETED', `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${getSriLankaTimestamp()}`, config.BOT_FOOTER);
        try { await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: message }); } catch (e) { console.error('RCD failed:', e.message); }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    return await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`);
        if (data) {
            const keys = Object.keys(data).filter(k => k.includes(sanitizedNumber) && k.endsWith('.json'));
            for (const k of keys) await axios.delete(`${FIREBASE_URL}/session/${k.replace('.json', '')}.json`);
        }
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            const numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (e) { console.error('Delete session failed:', e.message); }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`);
        return data || null;
    } catch { return null; }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session/config_${sanitizedNumber}.json`);
        return data || { ...config };
    } catch { return { ...config }; }
}

async function updateUserConfig(number, newConfig) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    await axios.put(`${FIREBASE_URL}/session/config_${sanitizedNumber}.json`, newConfig);
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await axios.delete(`${FIREBASE_URL}/session/session_${sanitizedNumber}.json`);
    } catch (e) { console.error(e.message); }
}

async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        const paths = [`session/creds_${sanitizedNumber}`, `session/config_${sanitizedNumber}`, `numbers/${sanitizedNumber}`];
        for (const p of paths) { try { await axios.delete(`${FIREBASE_URL}/${p}.json`); } catch {} }
        try {
            const r = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let nums = Array.isArray(r.data) ? r.data : [];
            nums = nums.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, nums);
        } catch {}
        if (activeSockets.has(sanitizedNumber)) {
            try { activeSockets.get(sanitizedNumber).ws.close(); } catch {}
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
        }
    } catch (e) { console.error(`Full delete failed:`, e.message); }
}function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                await fullDeleteSession(number);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
            } else {
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await cleanDuplicateFiles(sanitizedNumber);
    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });
    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });
        socketCreationTime.set(sanitizedNumber, Date.now());
        setupAutoRestart(socket, sanitizedNumber);
        handleMessageRevocation(socket, sanitizedNumber);
        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES, code;
            while (retries > 0) {
                try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; }
                catch (error) { retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
            }
            if (!res.headersSent) res.send({ code });
        }
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
        });
        socket.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    try { await loadUserConfig(sanitizedNumber); } catch { await updateUserConfig(sanitizedNumber, config); }
                    activeSockets.set(sanitizedNumber, socket);
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(config.BOT_NAME, `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n> ${config.BOT_FOOTER}`, config.BOT_FOOTER)
                    });
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    let numbers = numbersRes.data || [];
                    if (!numbers.includes(sanitizedNumber)) { numbers.push(sanitizedNumber); await axios.put(`${FIREBASE_URL}/numbers.json`, numbers); }
                } catch (e) { exec(`pm2 restart ${config.PM2_NAME}`); }
            }
        });
    } catch (error) {
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

async function handlePair(req, res) {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number parameter is required' });
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
    await EmpirePair(number, res);
}

router.get('/', handlePair);
router.get('/code', handlePair);
router.get('/pair', handlePair);
router.get('/active', (req, res) => res.status(200).send({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) }));
router.get('/ping', (req, res) => res.status(200).send({ status: 'active', message: '👻 MIZU-MD is running', bot: config.BOT_NAME, activesession: activeSockets.size }));
router.get('/health', (req, res) => res.status(200).send({ status: 'ok', bot: 'MIZU-MD' }));

router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            return { number, status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline', uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`, connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) };
        });
        res.json({ count: bots.length, bots });
    } catch (err) { res.status(500).json({ error: 'Failed to get bot info', details: err.message }); }
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (!numbers.length) return res.status(404).send({ error: 'No numbers found' });
        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (e) { res.status(500).send({ error: 'Failed to connect all bots' }); }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(k => k.startsWith('creds_') && k.endsWith('.json'));
        if (!sessionKeys.length) return res.status(404).send({ error: 'No session files found' });
        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) { results.push({ file: key, status: 'skipped' }); continue; }
            const number = match[1];
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); }
            catch (e) { results.push({ number, status: 'failed', error: e.message }); }
            await delay(1000);
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (e) { res.status(500).send({ error: 'Failed to reconnect bots' }); }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
    let newConfig;
    try { newConfig = JSON.parse(configString); } catch { return res.status(400).send({ error: 'Invalid config format' }); }
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) return res.status(404).send({ error: 'No active session found' });
    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
    try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent' }); }
    catch { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const stored = otpStore.get(sanitizedNumber);
    if (!stored) return res.status(400).send({ error: 'No OTP request found' });
    if (Date.now() >= stored.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP expired' }); }
    if (stored.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
    try {
        await updateUserConfig(sanitizedNumber, stored.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) await socket.sendMessage(jidNormalizedUser(socket.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', config.BOT_FOOTER) });
        res.status(200).send({ status: 'success' });
    } catch { res.status(500).send({ error: 'Failed to update config' }); }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) return res.status(400).send({ error: 'Number and target required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) return res.status(404).send({ error: 'No active session' });
    try {
        const statusData = await socket.fetchStatus(`${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
        res.status(200).send({ status: 'success', number: target, about: statusData.status || 'No status', setAt: statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown' });
    } catch (e) { res.status(500).send({ status: 'error', message: `Failed to fetch About for ${target}` }); }
});

process.on('exit', () => {
    activeSockets.forEach((s) => { try { s.ws.close(); } catch {} });
    activeSockets.clear();
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${config.PM2_NAME}`);
});

async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                await delay(1000);
            }
        }
    } catch (e) { console.error('autoReconnect error:', e.message); }
}
autoReconnectFromFirebase();

module.exports = router;
