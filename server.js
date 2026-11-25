require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { getDb } = require('./firebase');
const { restoreSessionFromFirestore, backupSessionToFirestore } = require('./sessionSync');

const app = express();
let reconnectTimer = null;

// Track last alerted batch per target phone for direct interactive YES/NO replies
const activeBatchAlerts = new Map();
let pendingAlertQueue = [];

async function loadAlertQueue(db) {
  if (pendingAlertQueue.length > 0) return pendingAlertQueue;
  if (!db) return [];
  try {
    const doc = await db.collection('welfare_settings').doc('alert_queue').get();
    if (doc.exists && Array.isArray(doc.data()?.queue)) {
      pendingAlertQueue = doc.data().queue;
      return pendingAlertQueue;
    }
  } catch (err) {
    console.error('❌ Error loading alert queue from Firestore:', err.message);
  }
  return [];
}

async function saveAlertQueue(db, queue) {
  pendingAlertQueue = Array.isArray(queue) ? queue : [];
  if (!db) return;
  try {
    await db.collection('welfare_settings').doc('alert_queue').set({
      queue: pendingAlertQueue,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Error saving alert queue to Firestore:', err.message);
  }
}

function formatDisplayDate(expiryDateVal) {
  const iso = formatDateString(expiryDateVal);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const mmm = months[m - 1] || String(m).padStart(2, '0');
  return `${dd}/${mmm}/${y}`;
}

function getColorTheme(days) {
  if (days <= 3) {
    return { bar: '🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥', dot: '🔴' };
  } else if (days <= 14) {
    return { bar: '🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧', dot: '🟠' };
  } else if (days <= 30) {
    return { bar: '🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨', dot: '🟡' };
  } else {
    return { bar: '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩', dot: '🟢' };
  }
}

function formatRemainingDaysValue(days) {
  if (days === null || days === undefined) return '--';
  if (days < 0) return `00 (Expired ${String(Math.abs(days)).padStart(2, '0')}d ago)`;
  return String(days).padStart(2, '0');
}

function formatQueueAlertMessage(item, remainingAfterThis, isNext = false) {
  const days = item.days !== undefined ? item.days : getDaysRemaining(item.expiryDate);
  const { bar, dot } = getColorTheme(days);
  const countLabel = item.total && item.total > 1 ? ` (${item.index}/${item.total})` : '';
  const displayDate = formatDisplayDate(item.expiryDate);
  const remainingStr = formatRemainingDaysValue(days);

  const queueFooter = remainingAfterThis > 0
    ? `\n\n⏳ _(${remainingAfterThis} more item(s) waiting in queue)_`
    : '';

  return `${bar}
${dot} *W̲E̲L̲F̲A̲R̲E̲ S̲H̲O̲P̲ E̲X̲P̲I̲R̲Y̲ A̲L̲E̲R̲T̲*${countLabel}
✓ Item – *${item.itemName}*
✓ Expiry Date – *${displayDate}*
✓ Remaining days – *${remainingStr}*
✓ Still in stock? Reply *YES* or *NO*${queueFooter}`;
}

async function dispatchNextFromQueue(db, targetNumbers, isNext = false) {
  await loadAlertQueue(db);

  while (pendingAlertQueue.length > 0) {
    const item = pendingAlertQueue[0];
    try {
      const batchDoc = await db.collection('welfare_stock_batches').doc(item.batchId).get();
      if (!batchDoc.exists) {
        console.log(`ℹ️ [Queue] Welfare Batch ${item.batchId} (${item.itemName}) no longer exists. Skipping to next...`);
        pendingAlertQueue.shift();
        continue;
      }
    } catch (e) {
      // transient read error
    }

    const remainingAfterThis = pendingAlertQueue.length - 1;
    const alertMessage = formatQueueAlertMessage(item, remainingAfterThis, isNext);

    if (connectionStatus === 'CONNECTED' && sock) {
      for (const targetPhone of targetNumbers) {
        const targetJid = `${targetPhone}@s.whatsapp.net`;
        await sock.sendMessage(targetJid, { text: alertMessage });
        console.log(`📤 [Welfare Queue Alert ${item.index}/${item.total}] Sent to +${targetPhone} for ${item.itemName} (Remaining: ${remainingAfterThis})`);

        activeBatchAlerts.set(targetPhone, item);
        const knownLid = getLidForPhone(targetPhone);
        if (knownLid) {
          activeBatchAlerts.set(knownLid, item);
        }
      }

      await db.collection('welfare_stock_batches').doc(item.batchId).update({
        lastAlertSent: item.milestone,
        lastAlertDate: new Date().toISOString()
      }).catch(() => { });

      await saveAlertQueue(db, pendingAlertQueue);
      return item;
    } else {
      console.log(`⚠️ WhatsApp bot not connected. Welfare queue item ${item.itemName} remains waiting.`);
      await saveAlertQueue(db, pendingAlertQueue);
      return null;
    }
  }

  await saveAlertQueue(db, []);
  return null;
}

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '94' + cleaned.substring(1);
  }
  return cleaned;
}

function formatDateString(expiryDateVal) {
  if (!expiryDateVal) return null;
  if (typeof expiryDateVal === 'string') {
    return expiryDateVal.trim().split('T')[0];
  }
  if (expiryDateVal && typeof expiryDateVal.toDate === 'function') {
    const d = expiryDateVal.toDate();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (expiryDateVal instanceof Date) {
    const y = expiryDateVal.getFullYear();
    const m = String(expiryDateVal.getMonth() + 1).padStart(2, '0');
    const day = String(expiryDateVal.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

function getDaysRemaining(expiryDateVal) {
  const dateStr = formatDateString(expiryDateVal);
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

  const [y, m, d] = dateStr.split('-').map(Number);
  const expUtc = Date.UTC(y, m - 1, d);

  const now = new Date();
  const colomboDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
  const [cy, cm, cd] = colomboDateStr.split('-').map(Number);
  const nowUtc = Date.UTC(cy, cm - 1, cd);

  return Math.round((expUtc - nowUtc) / (1000 * 60 * 60 * 24));
}

let sock = null;
let latestQrDataUrl = null;
let connectionStatus = 'DISCONNECTED';
let botPhoneNumber = null;
let isConnecting = false;
let currentSocketId = 0;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

function destroyCurrentSocket() {
  currentSocketId++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    const oldSock = sock;
    sock = null;
    try { oldSock.ev.removeAllListeners(); } catch (e) { }
    try { oldSock.ws?.close(); } catch (e) { }
    try { oldSock.end(); } catch (e) { }
  }
}

function scheduleReconnect(delayMs, force = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp(force);
  }, delayMs);
}

async function connectToWhatsApp(forceNew = false) {
  if (isConnecting) {
    console.log('⏳ [Baileys] Connection attempt already in progress. Skipping duplicate.');
    return;
  }

  isConnecting = true;
  destroyCurrentSocket();
  const mySocketId = currentSocketId;

  try {
    const firestore = getDb();
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    if (forceNew) {
      console.log('🔄 [Baileys] Force fresh connection requested.');
    } else {
      await restoreSessionFromFirestore(AUTH_DIR, firestore);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const mySock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['SLAF Welfare Shop Bot', 'Chrome', '120.0.0']
    });

    sock = mySock;

    mySock.ev.on('creds.update', async () => {
      if (mySocketId !== currentSocketId) return;
      await saveCreds();
      backupSessionToFirestore(AUTH_DIR, firestore);
    });

    mySock.ev.on('connection.update', async (update) => {
      if (mySocketId !== currentSocketId) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrDataUrl = await QRCode.toDataURL(qr);
        connectionStatus = 'QR_READY';
        console.log('📷 [Baileys] New Welfare Shop WhatsApp QR code ready. Visit /qr to scan.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;

        console.log(`⚠️ [Baileys] Connection closed: Status Code ${statusCode} (Logged Out: ${isLoggedOut})`);

        latestQrDataUrl = null;
        isConnecting = false;
        connectionStatus = 'DISCONNECTED';

        if (isRestartRequired) {
          console.log('🔄 [Baileys] Pairing handshake complete (515). Reconnecting immediately...');
          scheduleReconnect(300, true);
          return;
        }

        if (isLoggedOut) {
          console.log('🚨 [Baileys] Bot logged out or session unlinked. Clearing auth state...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) { }

          if (firestore) {
            firestore.collection('welfare_whatsapp_session').doc('backup').delete().catch(() => { });
          }
          scheduleReconnect(1500, true);
        } else {
          scheduleReconnect(3000, true);
        }
      } else if (connection === 'open') {
        if (mySocketId !== currentSocketId) return;

        latestQrDataUrl = null;
        connectionStatus = 'CONNECTED';
        isConnecting = false;

        const rawBotJid = mySock.user?.id || '';
        botPhoneNumber = cleanPhoneNumber(rawBotJid.split(':')[0].split('@')[0]);
        console.log(`✅ [Baileys Connected] SLAF Welfare Shop Bot ONLINE as +${botPhoneNumber}`);

        backupSessionToFirestore(AUTH_DIR, firestore, true);

        if (firestore) {
          firestore.collection('welfare_settings').doc('config').set({
            botStatus: 'CONNECTED',
            botPhoneNumber: botPhoneNumber,
            lastConnectedAt: new Date().toISOString()
          }, { merge: true }).catch(() => { });
        }
      }
    });

    mySock.ev.on('messages.upsert', async (m) => {
      if (mySocketId !== currentSocketId) return;
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.includes('@g.us')) continue; // Ignore groups

        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''
        ).trim();

        if (text) {
          await handleIncomingReply(text, remoteJid);
        }
      }
    });

  } catch (error) {
    if (mySocketId !== currentSocketId) return;
    console.error('❌ [Baileys Connection Error]:', error);
    isConnecting = false;
    connectionStatus = 'DISCONNECTED';
    scheduleReconnect(5000, true);
  }
}

async function getTargetPhoneNumbers(db) {
  try {
    const configDoc = await db.collection('welfare_settings').doc('config').get();
    if (!configDoc.exists) {
      // Fallback: Check if config is in settings/config
      const legacyDoc = await db.collection('settings').doc('config').get();
      if (legacyDoc.exists) {
        const data = legacyDoc.data() || {};
        const numbers = [];
        if (Array.isArray(data.targetWhatsAppNumbers)) {
          data.targetWhatsAppNumbers.forEach(p => {
            const cleaned = cleanPhoneNumber(p);
            if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
          });
        }
        return numbers;
      }
      return [];
    }
    const data = configDoc.data() || {};
    const numbers = [];

    if (Array.isArray(data.targetWhatsAppNumbers) && data.targetWhatsAppNumbers.length > 0) {
      data.targetWhatsAppNumbers.forEach(p => {
        const cleaned = cleanPhoneNumber(p);
        if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
      });
    }

    if (numbers.length === 0 && data.targetWhatsAppNumber) {
      const cleaned = cleanPhoneNumber(data.targetWhatsAppNumber);
      if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
    }

    return numbers;
  } catch (err) {
    console.error('❌ Error fetching Welfare Shop target phone numbers:', err.message);
    return [];
  }
}

function getAlertMilestone(days, lastAlertSent, isManual = false) {
  if (days === null) return null;
  let milestone = null;

  if (days <= 3) {
    if (lastAlertSent !== '3_DAYS') milestone = '3_DAYS';
  } else if (days <= 7) {
    if (lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '7_DAYS';
  } else if (days <= 14) {
    if (lastAlertSent !== '14_DAYS' && lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '14_DAYS';
  } else if (days <= 30) {
    if (lastAlertSent !== '30_DAYS' && lastAlertSent !== '14_DAYS' && lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '30_DAYS';
  } else if (days <= 60) {
    if (!['60_DAYS', '30_DAYS', '14_DAYS', '7_DAYS', '3_DAYS'].includes(lastAlertSent)) milestone = '60_DAYS';
  } else if (days <= 90) {
    if (!['90_DAYS', '60_DAYS', '30_DAYS', '14_DAYS', '7_DAYS', '3_DAYS'].includes(lastAlertSent)) milestone = '90_DAYS';
  }

  if (isManual && !milestone && days <= 90) {
    if (days <= 3) milestone = '3_DAYS';
    else if (days <= 7) milestone = '7_DAYS';
    else if (days <= 14) milestone = '14_DAYS';
    else if (days <= 30) milestone = '30_DAYS';
    else if (days <= 60) milestone = '60_DAYS';
    else milestone = '90_DAYS';
  }

  return milestone;
}

function getMilestoneDescription(milestone, days) {
  if (days < 0) return `⚠️ *ALREADY EXPIRED (${Math.abs(days)} days ago)*`;
  if (days === 0) return `🚨 *EXPIRES TODAY*`;
  if (milestone === '3_DAYS') return `🚨 *${days} day(s) remaining (CRITICAL / URGENT)*`;
  if (milestone === '7_DAYS') return `⚠️ *1 week remaining (${days} days)*`;
  if (milestone === '14_DAYS') return `⚠️ *2 weeks remaining (${days} days)*`;
  if (milestone === '30_DAYS') return `📅 *1 month remaining (${days} days)*`;
  if (milestone === '60_DAYS') return `📅 *2 months remaining (${days} days)*`;
  if (milestone === '90_DAYS') return `📅 *3 months remaining (${days} days)*`;
  return `*${days} days remaining*`;
}

function resolvePhoneFromJid(jid) {
  if (!jid) return '';
  const rawId = jid.split('@')[0].split(':')[0];

  if (jid.includes('@lid')) {
    try {
      const reverseMapPath = path.join(AUTH_DIR, `lid-mapping-${rawId}_reverse.json`);
      if (fs.existsSync(reverseMapPath)) {
        const rawPhone = JSON.parse(fs.readFileSync(reverseMapPath, 'utf8'));
        if (rawPhone) return cleanPhoneNumber(rawPhone);
      }
    } catch (e) { }
  }

  return cleanPhoneNumber(rawId);
}

function getLidForPhone(phone) {
  const cleaned = cleanPhoneNumber(phone);
  if (!cleaned) return null;
  try {
    const mapPath = path.join(AUTH_DIR, `lid-mapping-${cleaned}.json`);
    if (fs.existsSync(mapPath)) {
      const rawLid = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      if (rawLid) return String(rawLid).trim();
    }
  } catch (e) { }
  return null;
}

function isPhoneInTargetList(phone, rawId, targetList) {
  if (!Array.isArray(targetList) || targetList.length === 0) return false;
  return targetList.some(target => {
    if (phone && (phone === target || phone.endsWith(target) || target.endsWith(phone))) return true;
    const knownLid = getLidForPhone(target);
    if (knownLid && rawId && (rawId === knownLid || rawId.endsWith(knownLid))) return true;
    return false;
  });
}

/**
 * Handle Two-Way Replies ("YES" or "NO") with One-by-One Waiting Queue
 */
async function handleIncomingReply(text, remoteJid) {
  const db = getDb();
  if (!db) {
    console.error('❌ Firestore not initialized.');
    return;
  }

  const targetNumbers = await getTargetPhoneNumbers(db);
  const resolvedPhone = resolvePhoneFromJid(remoteJid);
  const rawId = remoteJid.split('@')[0].split(':')[0];

  console.log(`📩 [WhatsApp Received - Welfare] From: ${remoteJid} (Phone: +${resolvedPhone}) | Message: "${text}"`);

  const isAuthorized = targetNumbers.length === 0 || isPhoneInTargetList(resolvedPhone, rawId, targetNumbers);
  if (!isAuthorized) {
    console.log(`ℹ️ [Ignored Unauthorized] Message received from unregistered phone: +${resolvedPhone}`);
    return;
  }

  const normalized = text.trim().toUpperCase();

  // Strict matching for YES and NO
  const cleanInput = normalized.replace(/[^A-Z]/g, '');
  const isNo = /^(NO|N|NAHA|PNAHA|REMOVE|FINISH|FINISHED|OUTOFSTOCK|CLEAR)$/i.test(cleanInput);
  const isYes = /^(YES|Y|OW|HARI|DONE|COMPLETED|KEEP|STILLINSTOCK|AVAILABLE)$/i.test(cleanInput);

  // STRICT SILENT PROTECTION: Ignore accidental words
  if (!isYes && !isNo) {
    console.log(`ℹ️ [Silently Ignored] Received non-actionable message: "${text}" from +${resolvedPhone}. No reply sent.`);
    return;
  }

  const queue = await loadAlertQueue(db);
  let targetBatch = queue.length > 0 ? queue[0] : null;

  if (!targetBatch) {
    targetBatch = activeBatchAlerts.get(resolvedPhone) || activeBatchAlerts.get(rawId);
  }

  if (!targetBatch && activeBatchAlerts.size === 1) {
    targetBatch = Array.from(activeBatchAlerts.values())[0];
  }

  if (!targetBatch) {
    // Query nearest expiring batch from welfare_stock_batches
    const batchesSnap = await db.collection('welfare_stock_batches')
      .orderBy('expiryDate', 'asc')
      .limit(1)
      .get();

    if (!batchesSnap.empty) {
      const doc = batchesSnap.docs[0];
      targetBatch = { batchId: doc.id, ...doc.data() };
    }
  }

  if (!targetBatch) {
    await sock.sendMessage(remoteJid, {
      text: 'ℹ️ No pending active welfare items found requiring review. All store alerts are currently up to date.'
    });
    return;
  }

  const expDateStr = formatDisplayDate(targetBatch.expiryDate);
  const progressLabel = targetBatch.total ? ` (${targetBatch.index}/${targetBatch.total})` : '';

  if (isNo) {
    // DELETE BATCH DOCUMENT FROM FIRESTORE
    try {
      await db.collection('welfare_stock_batches').doc(targetBatch.batchId).delete();
      console.log(`🗑️ [Welfare Batch Deleted] Deleted batch ${targetBatch.batchId} (${targetBatch.itemName}) from Firestore.`);

      activeBatchAlerts.delete(resolvedPhone);
      activeBatchAlerts.delete(rawId);

      if (queue.length > 0 && queue[0].batchId === targetBatch.batchId) {
        queue.shift();
        await saveAlertQueue(db, queue);
      }

      if (queue.length > 0) {
        const replyText = `✅ *Removed from Welfare Stock${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) has been cleared from store stock batches.`;
        await sock.sendMessage(remoteJid, { text: replyText });

        const nextSent = await dispatchNextFromQueue(db, targetNumbers, true);
        if (!nextSent) {
          await sock.sendMessage(remoteJid, {
            text: `🎉 *All pending welfare expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`
          });
        }
      } else {
        const replyText = `✅ *Removed from Active Tracking${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) has been cleared from store stock batches.
No further expiry warnings will be sent.

🎉 *All pending welfare expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`;
        await sock.sendMessage(remoteJid, { text: replyText });
      }
    } catch (err) {
      console.error('❌ Error deleting welfare batch document:', err);
    }
  } else if (isYes) {
    activeBatchAlerts.delete(resolvedPhone);
    activeBatchAlerts.delete(rawId);

    if (queue.length > 0 && queue[0].batchId === targetBatch.batchId) {
      queue.shift();
      await saveAlertQueue(db, queue);
    }

    if (queue.length > 0) {
      const replyText = `👍 *Kept Active${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) remains active in welfare shop tracking.`;
      await sock.sendMessage(remoteJid, { text: replyText });

      const nextSent = await dispatchNextFromQueue(db, targetNumbers, true);
      if (!nextSent) {
        await sock.sendMessage(remoteJid, {
          text: `🎉 *All pending welfare expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`
        });
      }
    } else {
      const replyText = `👍 *Kept Active${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) remains active in welfare shop tracking.
Next reminder will be sent as scheduled.

🎉 *All pending welfare expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`;
      await sock.sendMessage(remoteJid, { text: replyText });
    }
  }
}

/**
 * Daily Automated Expiry Audit (Triggered via cron at 08:00 AM Asia/Colombo)
 */
async function runDailyExpiryAudit(isManual = false) {
  console.log(`⏰ [Welfare Audit] Running expiry audit (Manual: ${isManual}, Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })})...`);

  const db = getDb();
  if (!db) {
    console.error('❌ Cannot run audit: Firestore disconnected.');
    return { count: 0, error: 'Firestore disconnected' };
  }

  const targetNumbers = await getTargetPhoneNumbers(db);
  if (targetNumbers.length === 0) {
    console.log('⚠️ [Welfare Audit] No target WhatsApp numbers configured in welfare_settings/config.');
    return { count: 0, message: 'targetWhatsAppNumbers empty' };
  }

  const snapshot = await db.collection('welfare_stock_batches').get();
  if (snapshot.empty) {
    console.log('ℹ️ [Welfare Audit] No batches found in welfare_stock_batches collection.');
    await saveAlertQueue(db, []);
    return { count: 0, message: 'No batches' };
  }

  const candidates = [];
  for (const doc of snapshot.docs) {
    const batch = doc.data();
    const batchId = doc.id;
    const days = getDaysRemaining(batch.expiryDate);

    if (days === null) continue;

    const milestone = getAlertMilestone(days, batch.lastAlertSent, isManual);
    if (milestone) {
      candidates.push({
        batchId,
        itemName: batch.itemName,
        expiryDate: formatDateString(batch.expiryDate),
        days,
        milestone,
        milestoneDesc: getMilestoneDescription(milestone, days)
      });
    }
  }

  if (candidates.length === 0) {
    console.log('🏁 [Welfare Audit Finished] No items require alerts today.');
    return { count: 0, totalQueued: 0, recipients: targetNumbers.length };
  }

  candidates.sort((a, b) => a.days - b.days);

  const total = candidates.length;
  const queueItems = candidates.map((item, idx) => ({
    ...item,
    index: idx + 1,
    total
  }));

  await saveAlertQueue(db, queueItems);
  console.log(`📋 [Welfare Audit Queue Created] ${total} item(s) queued. Dispatching item 1 of ${total}...`);

  const firstDispatched = await dispatchNextFromQueue(db, targetNumbers, false);
  const alertsDispatched = firstDispatched ? 1 : 0;

  return { count: alertsDispatched, totalQueued: total, recipients: targetNumbers.length };
}

// Scheduled Cron: Runs every day at 08:00 AM (Asia/Colombo)
cron.schedule('0 8 * * *', () => {
  runDailyExpiryAudit(false);
}, {
  timezone: 'Asia/Colombo'
});

// -------------------------------------------------------------
// Web Routes & Dashboard
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>SLAF Welfare Shop WhatsApp Automation Service</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070d19; color: #f8fafc; padding: 30px; text-align: center; }
          .card { max-width: 600px; margin: 0 auto; background: #0f172a; padding: 25px; border-radius: 16px; border: 1px solid #1e293b; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
          .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 0.85rem; margin-top: 10px; }
          .connected { background: #065f46; color: #6ee7b7; border: 1px solid #10b981; }
          .qr_ready { background: #854d0e; color: #fef08a; border: 1px solid #facc15; }
          .disconnected { background: #991b1b; color: #fca5a5; border: 1px solid #ef4444; }
          .btn { display: inline-block; padding: 10px 18px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; margin: 8px; font-weight: 600; cursor: pointer; border: none; font-size: 0.95rem; }
          .btn-emerald { background: #10b981; }
          .btn-danger { background: #dc2626; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 0.85rem; letter-spacing: 2px; color: #f59e0b; font-weight: 800; text-transform: uppercase; margin-bottom: 8px;">Sri Lanka Air Force • Station Sigiriya</div>
          <h2 style="color: #38bdf8; margin: 0 0 10px 0;">🛒 Welfare Shop WhatsApp Automation Service</h2>
          <p style="color: #94a3b8; font-size: 0.95rem;">Dedicated Baileys Engine synced with Firestore (Welfare Shop)</p>
          <div>
            Status: 
            <span class="badge ${connectionStatus.toLowerCase()}">${connectionStatus}</span>
          </div>
          ${botPhoneNumber ? `<p style="color: #38bdf8; font-family: monospace; font-size: 1.15rem; margin-top: 15px;">Connected Bot: <strong>+${botPhoneNumber}</strong></p>` : ''}
          <div style="margin-top: 25px;">
            <a class="btn btn-emerald" href="/qr">📱 Scan QR Code</a>
            <a class="btn" href="/inspection" style="background:#0284c7;">📋 Live Expiry Inspection</a>
            <button class="btn" onclick="fetch('/api/check-now', {method: 'POST'}).then(r=>r.json()).then(d=>alert('Audit Triggered: ' + JSON.stringify(d)))">⚡ Run Expiry Check Now</button>
            ${connectionStatus === 'CONNECTED' ? `<button class="btn btn-danger" onclick="if(confirm('Unlink this bot number?')){ fetch('/api/logout', {method: 'POST'}).then(() => window.location='/qr'); }">🔄 Change Bot Number</button>` : ''}
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  if (connectionStatus === 'CONNECTED') {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp Connected - Welfare Shop</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070d19; color: #f8fafc; padding: 40px; text-align: center;">
          <h2 style="color: #10b981;">✅ Welfare Shop WhatsApp Bot Connected!</h2>
          <p>Linked Sender Phone: <strong style="font-size: 1.2rem; color: #38bdf8;">+${botPhoneNumber}</strong></p>
          <p style="color: #94a3b8;">The Welfare Shop bot is active, sending expiry alerts and processing YES/NO stock reviews.</p>
          <div style="margin-top: 30px;">
            <a href="/" style="display: inline-block; padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">🏠 Main Dashboard</a>
            <a href="/inspection" style="display: inline-block; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-left: 10px;">📋 Live Inspection</a>
          </div>
        </body>
      </html>
    `);
  }

  if (!latestQrDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Generating QR - Welfare Shop</title>
          <meta http-equiv="refresh" content="5">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script>
            setInterval(async function() {
              try {
                const r = await fetch('/api/status');
                const data = await r.json();
                if (data.status === 'CONNECTED' || data.hasQr) {
                  window.location.reload();
                }
              } catch (e) {}
            }, 2000);
          </script>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070d19; color: #f8fafc; padding: 40px; text-align: center;">
          <div style="max-width: 400px; margin: 40px auto; background: #0f172a; padding: 30px; border-radius: 16px; border: 1px solid #1e293b;">
            <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid #1e293b; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
            <h2 style="margin: 0 0 10px 0; color: #38bdf8;">Generating QR Code...</h2>
            <p style="color: #94a3b8; font-size: 0.95rem;">Connecting Welfare Shop bot to WhatsApp servers...</p>
            <div style="margin-top: 15px;">
              <button onclick="window.location.reload()" style="padding: 8px 16px; background: #1e293b; color: white; border: none; border-radius: 6px; cursor: pointer;">🔄 Tap to Reload</button>
            </div>
          </div>
          <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pair WhatsApp - Welfare Shop</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script>
          let lastQr = "${latestQrDataUrl}";
          setInterval(async function() {
            try {
              const res = await fetch('/api/status');
              const data = await res.json();
              if (data.status === 'CONNECTED') {
                window.location.reload();
              } else if (data.hasQr && data.qrDataUrl && data.qrDataUrl !== lastQr) {
                lastQr = data.qrDataUrl;
                document.getElementById('qr-img').src = data.qrDataUrl;
              }
            } catch (err) {}
          }, 2000);
        </script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070d19; color: #f8fafc; padding: 20px; text-align: center; }
          .card { max-width: 440px; margin: 30px auto; background: #0f172a; padding: 30px; border-radius: 16px; border: 1px solid #1e293b; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
          .qr-box { background: white; padding: 16px; border-radius: 12px; display: inline-block; margin: 20px 0; }
          .qr-box img { width: 250px; height: 250px; display: block; }
          .steps { text-align: left; background: #1e293b; padding: 15px 20px; border-radius: 8px; font-size: 0.9rem; line-height: 1.6; color: #cbd5e1; }
          .steps ol { margin: 0; padding-left: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="color: #38bdf8; margin: 0 0 8px 0;">🛒 Pair Welfare Shop WhatsApp Bot</h2>
          <p style="color: #94a3b8; font-size: 0.9rem; margin: 0;">Scan this QR code with WhatsApp on the device to be used as bot sender</p>
          <div class="qr-box">
            <img id="qr-img" src="${latestQrDataUrl}" alt="WhatsApp QR Code">
          </div>
          <div class="steps">
            <ol>
              <li>Open WhatsApp on the bot phone</li>
              <li>Tap <strong>Settings</strong> or <strong>Menu (⋮)</strong></li>
              <li>Tap <strong>Linked Devices</strong></li>
              <li>Tap <strong>Link a Device</strong> and point your camera here</li>
            </ol>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get('/inspection', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(500).send('Firestore not connected');

  try {
    const batchesSnap = await db.collection('welfare_stock_batches').get();
    const masterSnap = await db.collection('welfare_items_master').get();

    const masterMap = {};
    masterSnap.forEach(doc => {
      masterMap[doc.id] = doc.data();
    });

    const items = [];
    batchesSnap.forEach(doc => {
      const data = doc.data();
      const days = getDaysRemaining(data.expiryDate);
      const master = masterMap[data.itemId] || {};
      const unit = master.unit || 'NOS';
      const itemName = data.itemName || master.itemName || 'Unknown Item';
      items.push({
        batchId: doc.id,
        itemId: data.itemId || '-',
        itemName: itemName,
        unit: unit,
        expiryDate: data.expiryDate || '',
        displayDate: formatDisplayDate(data.expiryDate),
        days: days !== null ? days : 9999
      });
    });

    items.sort((a, b) => a.days - b.days);

    let countExpired = 0;
    let countCritical = 0;
    let countUrgent = 0;
    let countWarning = 0;
    let countSafe = 0;

    items.forEach(it => {
      if (it.days < 0) countExpired++;
      else if (it.days <= 3) countCritical++;
      else if (it.days <= 14) countUrgent++;
      else if (it.days <= 30) countWarning++;
      else countSafe++;
    });

    const nowFormatted = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Colombo',
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>SLAF Welfare Shop - Live Expiry Inspection</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070d19; color: #f8fafc; padding: 20px; }
            .container { max-width: 900px; margin: 0 auto; }
            .header { background: #0f172a; border: 1px solid #1e293b; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 16px; }
            .stats { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
            .stat-box { flex: 1; min-width: 120px; background: #0f172a; padding: 14px; border-radius: 10px; border: 1px solid #1e293b; text-align: center; }
            .stat-box.crit { border-left: 4px solid #ef4444; }
            .stat-box.urg { border-left: 4px solid #f97316; }
            .stat-box.warn { border-left: 4px solid #eab308; }
            .stat-box.safe { border-left: 4px solid #10b981; }
            .stat-num { font-size: 1.6rem; font-weight: 900; }
            .stat-lbl { font-size: 0.72rem; text-transform: uppercase; color: #94a3b8; font-weight: bold; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b; }
            th { background: #1e293b; color: #94a3b8; padding: 12px; font-size: 0.8rem; text-align: left; }
            td { padding: 12px; border-top: 1px solid #1e293b; font-size: 0.9rem; }
            .pill { display: inline-block; padding: 4px 10px; border-radius: 20px; font-weight: bold; font-size: 0.75rem; }
            .crit-pill { background: #7f1d1d; color: #fca5a5; }
            .urg-pill { background: #7c2d12; color: #fdba74; }
            .warn-pill { background: #713f12; color: #fef08a; }
            .safe-pill { background: #064e3b; color: #6ee7b7; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div style="color: #f59e0b; font-size: 0.8rem; font-weight: 800; letter-spacing: 2px;">SRI LANKA AIR FORCE • STATION SIGIRIYA</div>
              <h2 style="color: #38bdf8; margin: 4px 0;">🛒 Welfare Shop Live Expiry Inspection</h2>
              <div style="color: #94a3b8; font-size: 0.85rem;">Last synced: ${nowFormatted}</div>
            </div>

            <div class="stats">
              <div class="stat-box crit"><div class="stat-num" style="color:#ef4444;">${countExpired + countCritical}</div><div class="stat-lbl">Critical (≤3d)</div></div>
              <div class="stat-box urg"><div class="stat-num" style="color:#f97316;">${countUrgent}</div><div class="stat-lbl">Urgent (4-14d)</div></div>
              <div class="stat-box warn"><div class="stat-num" style="color:#eab308;">${countWarning}</div><div class="stat-lbl">Warning (15-30d)</div></div>
              <div class="stat-box safe"><div class="stat-num" style="color:#10b981;">${countSafe}</div><div class="stat-lbl">Safe (>30d)</div></div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Expiry Date</th>
                  <th>Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${items.map(it => {
                  let pillClass = 'safe-pill';
                  let statusTxt = 'Safe';
                  if (it.days < 0) { pillClass = 'crit-pill'; statusTxt = 'Expired'; }
                  else if (it.days <= 3) { pillClass = 'crit-pill'; statusTxt = 'Critical'; }
                  else if (it.days <= 14) { pillClass = 'urg-pill'; statusTxt = 'Urgent'; }
                  else if (it.days <= 30) { pillClass = 'warn-pill'; statusTxt = 'Warning'; }

                  return `
                    <tr>
                      <td><strong>${it.itemName}</strong></td>
                      <td>${it.displayDate}</td>
                      <td>${it.days < 0 ? 'Expired' : it.days + ' days'}</td>
                      <td><span class="pill ${pillClass}">${statusTxt}</span></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error loading inspection dashboard: ' + err.message);
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    botPhoneNumber,
    hasQr: Boolean(latestQrDataUrl),
    qrDataUrl: latestQrDataUrl
  });
});

app.post('/api/check-now', async (req, res) => {
  try {
    const result = await runDailyExpiryAudit(true);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    destroyCurrentSocket();
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (e) { }

    const db = getDb();
    if (db) {
      await db.collection('welfare_whatsapp_session').doc('backup').delete().catch(() => { });
      await db.collection('welfare_settings').doc('config').set({
        botStatus: 'DISCONNECTED',
        botPhoneNumber: '',
        lastDisconnectedAt: new Date().toISOString()
      }, { merge: true }).catch(() => { });
    }

    scheduleReconnect(1000, true);
    res.json({ success: true, message: 'Welfare bot unlinked. New QR is ready.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🛒 WELFARE SHOP WHATSAPP SERVICE ONLINE (Port: ${PORT})`);
  console.log(`📱 QR Pairing: http://localhost:${PORT}/qr`);
  console.log(`📋 Inspection: http://localhost:${PORT}/inspection`);
  console.log(`⏰ Daily Expiry Check: 08:00 AM (Asia/Colombo)`);
  console.log(`=======================================================`);

  connectToWhatsApp(false);
});
