/**
 * Feishu (Lark) long-connection helper.
 *
 * - Uses the official @larksuiteoapi/node-sdk WSClient to receive events via
 *   an OUTBOUND WebSocket (no public IP / domain / tunnel required).
 * - On `im.message.receive_v1`, POSTs the message to the DSH plugin bridge URL.
 *
 * Env:
 *   FEISHU_APP_ID     (required)
 *   FEISHU_APP_SECRET (required)
 *   BRIDGE_URL        (required) e.g. http://127.0.0.1:3080/feishu/bridge
 */

import * as Lark from '@larksuiteoapi/node-sdk';

const APP_ID = String(process.env.FEISHU_APP_ID || '').trim();
const APP_SECRET = String(process.env.FEISHU_APP_SECRET || '').trim();
const BRIDGE_URL = String(process.env.BRIDGE_URL || '').trim();
const GROUP_ONLY_WHEN_MENTIONED =
  String(process.env.GROUP_ONLY_WHEN_MENTIONED || '1').trim() !== '0';

function log(...a) {
  console.log('[feishu-helper]', ...a);
}

if (!APP_ID || !APP_SECRET || !BRIDGE_URL) {
  log('FATAL: FEISHU_APP_ID, FEISHU_APP_SECRET and BRIDGE_URL are all required');
  process.exit(1);
}

// --- dedup (Feishu may deliver the same event more than once) ---
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;
function isDuplicate(messageId) {
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

// --- extract text from a Feishu message ---
function messageText(message) {
  const type = message?.message_type;
  if (type === 'text') {
    try {
      const parsed = JSON.parse(message.content || '{}');
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      return '';
    }
  }
  if (type === 'image') return '[图片]';
  if (type === 'file') return '[附件]';
  if (type === 'audio') return '[语音]';
  if (type === 'sticker') return '[表情]';
  if (type === 'post') {
    // rich-text post: flatten all text nodes
    try {
      const parsed = JSON.parse(message.content || '{}');
      const parts = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (typeof node.text === 'string' && node.text) parts.push(node.text);
        for (const key of ['children', 'elements', 'content']) {
          if (node[key]) walk(node[key]);
        }
      };
      walk(parsed);
      return parts.join('');
    } catch {
      return '[富文本消息]';
    }
  }
  return '';
}

async function postToBridge(payload) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    log('bridge POST failed:', res.status, res.statusText);
    return false;
  }
  return true;
}

const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new Lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: Lark.LoggerLevel.info,
});

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      const { message, sender } = data || {};
      const chatId = message?.chat_id;
      const messageId = message?.message_id;
      const chatType = message?.chat_type;
      const senderOpenId = sender?.sender_id?.open_id || '';

      if (!chatId || !messageId) return;
      if (isDuplicate(messageId)) return;

      const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
      const isGroup = chatType === 'group';

      // In groups, only respond when the bot is @-mentioned (v1 heuristic).
      if (isGroup && GROUP_ONLY_WHEN_MENTIONED && mentions.length === 0) return;

      let text = messageText(message);
      // Strip Feishu @_user_N placeholders.
      text = (text || '').replace(/@_user_\d+\s*/g, '').trim();
      if (!text) return;

      await postToBridge({
        chat_id: chatId,
        message_id: messageId,
        chat_type: chatType,
        sender_open_id: senderOpenId,
        is_group: isGroup,
        text,
      });
    } catch (e) {
      log('handler error:', e?.message || String(e));
    }
  },
});

wsClient.start({ eventDispatcher: dispatcher });
log('Feishu long-connection client started (appId=' + APP_ID.slice(0, 8) + '…)');
