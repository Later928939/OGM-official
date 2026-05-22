// OGM LINE Bot - Plan A
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

const lineConfig = {
      channelSecret: process.env.SECRET,
      channelAccessToken: process.env.TOKEN,
};
const client = new Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'ããªãã¯OGMå¬å¼LINEã®AIã¢ã·ã¹ã¿ã³ãã§ãã';
const GREETING_MSG = process.env.GREETING_MESSAGE || 'OGMã¸ããããï¼';
const SHEET_ID = process.env.SPREADSHEET_ID || '';

const sessions = new Map();

app.post('/webhook', middleware(lineConfig), async (req, res) => {
      res.sendStatus(200);
      for (const event of req.body.events || []) {
              try { await handleEvent(event); }
              catch (e) { console.error('Event error:', e.message); }
      }
});

async function handleEvent(event) {
      const { type, source, message } = event;
      const userId = source && source.userId;

  if (type === 'follow') {
          return reply(event.replyToken, GREETING_MSG);
  }
      if (type === 'postback') {
              return handlePostback(event);
      }
      if (type !== 'message' || !message || message.type !== 'text') return;

  const text = message.text.trim();

  if (ADMIN_IDS.includes(userId) && text.startsWith('/')) {
          return handleAdminCommand(userId, text, event.replyToken);
  }
      if (sessions.has(userId)) {
              return handleRegistration(userId, text, event.replyToken);
      }
      if (/^(ç»é²|åå ç»é²|ç»é²ãã|ã¡ã³ãã¼ç»é²)$/.test(text)) {
              sessions.set(userId, { step: 'studentId', data: {} });
              return reply(event.replyToken, 'ð ç»é²ãéå§ãã¾ãï¼\n\nã¾ãå­¦ç±çªå·ãå¥åãã¦ãã ããã\nï¼ä¾: AJE25053ï¼');
      }

  const aiReply = await callClaude(text).catch(() => 'å°ãèãããã¦ãã ãããããä¸åº¦ã¡ãã»ã¼ã¸ãéã£ã¦ã¿ã¦ãã ããã');
      return reply(event.replyToken, aiReply);
}

async function handleRegistration(userId, text, replyToken) {
      const session = sessions.get(userId);

  if (session.step === 'studentId') {
          if (!/^[a-zA-Z]{3}\d{5}$/.test(text)) {
                    return reply(replyToken, 'â ï¸ å­¦ç±çªå·ã®å½¢å¼ãæ­£ããããã¾ããã\nè±å­3æå­ï¼æ°å­5æ¡ã§å¥åãã¦ãã ããã\nä¾: AJE25053');
          }
          session.data.studentId = text.toUpperCase();
          session.step = 'name';
          return reply(replyToken, 'â å­¦ç±çªå·ãåãä»ãã¾ããã\n\næ¬¡ã«ãæ°åï¼ãã«ãã¼ã ï¼ãå¥åãã¦ãã ããã');
  }
      if (session.step === 'name') {
              if (text.length < 2 || text.length > 30) {
                        return reply(replyToken, 'â ï¸ æ°åã¯2ã30æå­ã§å¥åãã¦ãã ããã');
              }
              session.data.name = text;
              session.step = 'email';
              return reply(replyToken, 'â ' + text + ' ããããããã¨ããããã¾ãã\n\næå¾ã«ãå¤§å­¦ã®ã¡ã¼ã«ã¢ãã¬ã¹ãå¥åãã¦ãã ããã');
      }
      if (session.step === 'email') {
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                        return reply(replyToken, 'â ï¸ ã¡ã¼ã«ã¢ãã¬ã¹ã®å½¢å¼ãæ­£ããããã¾ãããååº¦å¥åãã¦ãã ããã');
              }
              session.data.email = text;
              sessions.delete(userId);
              await saveToSheet(userId, session.data);
              return reply(replyToken, 'ð ç»é²å®äºï¼\n\nãç»é²æå ±ã\nå­¦ç±çªå·: ' + session.data.studentId + '\næ°å: ' + session.data.name + '\nã¡ã¼ã«: ' + session.data.email + '\n\nOGMã¸ããããï¼ã¤ãã³ãã®è©³ç´°ã¯ãã®ã¢ã«ã¦ã³ããããç¥ãããã¾ãâ¨');
      }

  sessions.delete(userId);
      return reply(replyToken, 'ã»ãã·ã§ã³ããªã»ãããã¾ãããããä¸åº¦ãç»é²ãã¨éã£ã¦ãã ããã');
}

async function handleAdminCommand(userId, text, replyToken) {
      const today = new Date().toLocaleDateString('ja-JP', {
              timeZone: 'Asia/Tokyo',
              year: 'numeric', month: 'long', day: 'numeric'
      });

  if (text.startsWith('/åç¥')) {
          const arg = text.replace('/åç¥', '').trim();
          await reply(replyToken, 'â³ åç¥æãçæä¸­...');
          try {
                    const prompt = arg
                      ? 'ä»¥ä¸ã®ã¤ãã³ãã«ã¤ãã¦LINEåç¥æãä½æãã¦ãã ãã: "' + arg + '"\nä»æ¥ã®æ¥ä»ã¯' + today + 'ã§ããSYSTEM_PROMPTã«è¨è¼ã®æå ±ã®ã¿ä½¿ç¨ããæ¶ç©ºã®æå ±ã¯çµ¶å¯¾ã«è¿½å ããªãã§ãã ãããåç¥æã®ã¿ãè¿ãã¦ãã ããã'
                                : 'ä»æ¥ã®æ¥ä»ã¯' + today + 'ã§ããSYSTEM_PROMPTã«è¨è¼ããã¦ããä»å¾ã®ã¤ãã³ãï¼ä»æ¥ä»¥éã®æ¥ç¨ã®ãã®ï¼ã®ãã¡ãæãç´è¿ã®ãã®ãLINEåç¥æã«ãã¦ãã ãããéå»ã®æ¥ä»ã®ã¤ãã³ãã¯çµ¶å¯¾ã«ä½¿ç¨ããªãã§ãã ãããæ¶ç©ºã®æ¥ç¨ã»å ´æã»åå®¹ã¯çµ¶å¯¾ã«è¿½å ããªãã§ãã ãããåç¥æã®ã¿ãè¿ãã¦ãã ããã';
                    const announcement = await callClaude(prompt, 800);
                    console.log('Broadcasting announcement:', announcement.substring(0, 100));
                    await broadcast(announcement);
                    await push(userId, 'â åç¥ãå¨å¡ã«éä¿¡ãã¾ããã\n\néä¿¡åå®¹:\n' + announcement.substring(0, 150) + (announcement.length > 150 ? '...' : ''));
          } catch (e) {
                    console.error('/åç¥ error:', e.message);
                    await push(userId, 'â åç¥æã®çæã«å¤±æãã¾ãã: ' + e.message);
          }
          return;
  }

  if (text.startsWith('/å¨å¡ ')) {
          const msg = text.slice('/å¨å¡ '.length).trim();
          if (!msg) return reply(replyToken, 'â ï¸ ã¡ãã»ã¼ã¸ãå¥åãã¦ãã ããã');
          try {
                    await broadcast(msg);
                    return reply(replyToken, 'â å¨å¡ã«éä¿¡ãã¾ããã');
          } catch (e) {
                    return reply(replyToken, 'â éä¿¡å¤±æ: ' + e.message);
          }
  }

  if (text === '/ç»é²è') {
          const count = await getMemberCount();
          return reply(replyToken, 'ð ç¾å¨ã®ç»é²èæ°: ' + count + 'äºº');
  }

  if (text === '/ã¤ãã³ã') {
          try {
                    const res = await callClaude('ä»æ¥ã®æ¥ä»ã¯' + today + 'ã§ããSYSTEM_PROMPTã«è¨è¼ã®ä»å¾ã®ã¤ãã³ãä¸è¦§ï¼ä»æ¥ä»¥éã®æ¥ç¨ã®ãã®ï¼ããæ¥ä»ã»ã¤ãã³ãåã»å ´æãå«ãã¦æãã¦ãã ãããéå»ã®æ¥ä»ã®ã¤ãã³ãã¯å«ããªãã§ãã ãããæ¶ç©ºã®æå ±ã¯è¿½å ããªãã§ãã ããã', 600);
                    return reply(replyToken, res);
          } catch (e) {
                    return reply(replyToken, 'â åå¾å¤±æ: ' + e.message);
          }
  }

  if (text === '/ãã«ã' || text === '/help') {
          return reply(replyToken,
                             'ð ç®¡çèã³ãã³ãä¸è¦§\n' +
                             'âââââââââââââââ\n' +
                             '/åç¥ â ç´è¿ã¤ãã³ããåç¥æã«å¤æãã¦å¨å¡ã«éä¿¡\n' +
                             '/åç¥ [åå®¹] â æå®åå®¹ã®åç¥æãå¨å¡ã«éä¿¡\n' +
                             '/å¨å¡ [MSG] â å¨å¡ã«ãã­ã¹ãéä¿¡\n' +
                             '/ç»é²è â ç»é²èæ°ãç¢ºèª\n' +
                             '/ã¤ãã³ã â ä»å¾ã®ã¤ãã³ãä¸è¦§è¡¨ç¤º\n' +
                             '/ãã«ã â ãã®ãã«ã\n\n' +
                             'ð¡ ã¿ã°éä¿¡ã¯LINE OA Managerã§æåã§è¡ã£ã¦ãã ãã'
                           );
  }

  return reply(replyToken, 'â ï¸ ä¸æãªã³ãã³ãã§ãã/ãã«ã ã§ä¸è¦§ãç¢ºèªã§ãã¾ãã');
}

async function handlePostback(event) {
      const userId = event.source && event.source.userId;
      const params = new URLSearchParams(event.data);
      const action = params.get('action');
      const eventName = params.get('event');

  if (action === 'join') {
          await saveEventJoin(userId, eventName);
          return reply(event.replyToken, 'â ã' + eventName + 'ãã¸ã®åå ãåãä»ãã¾ããï¼\nè©³ç´°ã¯ã¹ã¿ãããããé£çµ¡ãã¾ããåå ãããã¨ããããã¾ãð');
  }
      if (action === 'decline') {
              return reply(event.replyToken, 'æ®å¿µï¼ã¾ããã¤ã§ãã¤ãã³ãã«åå ãã¦ãã ããð');
      }
}

async function callClaude(userPrompt, maxTokens) {
      if (!maxTokens) maxTokens = 500;
      const res = await anthropic.messages.create({
              model: 'claude-opus-4-5',
              max_tokens: maxTokens,
              system: SYSTEM_PROMPT,
              messages: [{ role: 'user', content: userPrompt }],
      });
      return res.content[0].text;
}

function reply(replyToken, text) {
      return client.replyMessage(replyToken, [{ type: 'text', text: text }]);
}

function push(userId, text) {
      return client.pushMessage(userId, [{ type: 'text', text: text }]);
}

async function broadcast(text) {
      console.log('broadcast() called, length:', text.length);
      try {
              const result = await client.broadcast([{ type: 'text', text: text }]);
              console.log('broadcast() success');
              return result;
      } catch (e) {
              console.error('broadcast() error:', e.message, e.statusCode);
              if (e.originalError && e.originalError.response) {
                        console.error('broadcast() detail:', JSON.stringify(e.originalError.response.data));
              }
              throw e;
      }
}

async function sheetsAppend(sheetName, values) {
  const url = process.env.GAS_WEBHOOK_URL;
  if (!url) { console.warn('GAS_WEBHOOK_URL not set — skipping'); return; }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheet: sheetName, values: values }),
    redirect: 'follow',
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error('GAS error:', JSON.stringify(json));
}
async function getMemberCount() {
      const token = process.env.GOOGLE_ACCESS_TOKEN;
      if (!token) return '(åå¾ä¸å¯: èªè¨¼æªè¨­å®)';
      const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/' + encodeURIComponent('ã¡ã³ãã¼ç®¡ç') + '!A:A';
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } }).catch(function() { return null; });
      if (!res || !res.ok) return '(åå¾å¤±æ)';
      const json = await res.json();
      return Math.max(0, (json.values ? json.values.length : 1) - 1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('OGM Bot listening on port ' + PORT); });
