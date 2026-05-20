const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();

const lineConfig = {
    channelSecret: process.env.SECRET,
    channelAccessToken: process.env.TOKEN,
};

const client = new Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Admin & State Management ---
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const userStates = new Map(); // { userId: { step, data } }

// --- Webhook ---
app.post('/webhook', middleware(lineConfig), async (req, res) => {
    res.status(200).end();
    const events = req.body.events;
    for (const event of events) {
          if (event.type === 'follow') {
                  await handleFollow(event);
          } else if (event.type === 'message' && event.message.type === 'text') {
                  await handleMessage(event);
          } else if (event.type === 'postback') {
                  await handlePostback(event);
          }
    }
});

// --- Follow Handler ---
async function handleFollow(event) {
    const greeting = process.env.GREETING_MESSAGE || 'OGM公式LINEへようこそ！\n\n参加登録は「登録」と送信してください。';
    await client.replyMessage(event.replyToken, { type: 'text', text: greeting });
}

// --- Message Handler ---
async function handleMessage(event) {
    const userId = event.source.userId;
    const text = event.message.text.trim();

  // Admin commands
  if (ADMIN_IDS.includes(userId)) {
        const handled = await handleAdminCommand(userId, text, event.replyToken);
        if (handled) return;
  }

  // Registration flow
  if (text === '登録' || text === '参加登録') {
        userStates.set(userId, { step: 'student_id', data: {} });
        await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '📝 参加登録を開始します！\n\n学籍番号を入力してください\n（例: k24001234）'
        });
        return;
  }

  const state = userStates.get(userId);
    if (state) {
          await handleRegistration(userId, text, event.replyToken, state);
          return;
    }

  // AI fallback
  const systemPrompt = process.env.SYSTEM_PROMPT || 'You are OGM assistant. OGM is an international exchange club at Osaka Metropolitan University.';
    const response = await anthropic.messages.create({
          model: 'claude-opus-4-5',
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: text }]
    });
    const replyText = response.content[0].text;
    await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

// --- Registration Flow ---
async function handleRegistration(userId, text, replyToken, state) {
    switch (state.step) {
      case 'student_id':
              if (!/^[a-zA-Z]\d{6,8}$/.test(text)) {
                        await client.replyMessage(replyToken, { type: 'text', text: '⚠️ 形式が正しくありません\n例: k24001234\nもう一度入力してください。' });
                        return;
              }
              state.data.studentId = text;
              state.step = 'name';
              userStates.set(userId, state);
              await client.replyMessage(replyToken, { type: 'text', text: '👤 お名前をフルネームで入力してください' });
              break;

      case 'name':
              state.data.name = text;
              state.step = 'email';
              userStates.set(userId, state);
              await client.replyMessage(replyToken, { type: 'text', text: '📧 メールアドレスを入力してください' });
              break;

      case 'email':
              if (!text.includes('@') || !text.includes('.')) {
                        await client.replyMessage(replyToken, { type: 'text', text: '⚠️ 正しいメールアドレスを入力してください' });
                        return;
              }
              state.data.email = text;
              userStates.delete(userId);

        await saveToSheet(userId, state.data);

        await client.replyMessage(replyToken, {
                  type: 'text',
                  text: `✅ 登録完了！\n\n学籍番号: ${state.data.studentId}\nお名前: ${state.data.name}\nメール: ${state.data.email}\n\nOGMへようこそ！🎉\nイベント情報をお待ちください。`
        });
              break;
    }
}

// --- Postback Handler (event join/decline) ---
async function handlePostback(event) {
    const userId = event.source.userId;
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    const tagId = data.get('tagId');
    const eventName = data.get('eventName');

  if (action === 'join' && tagId) {
        await addTagToUser(userId, tagId);
        await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `✅ 【${eventName}】の参加登録が完了しました！\n詳細は後日お知らせします。`
        });
  } else if (action === 'decline') {
        await client.replyMessage(event.replyToken, {
                type: 'text', text: 'またの機会にぜひ参加してください！😊'
        });
  }
}

// --- Admin Commands ---
async function handleAdminCommand(userId, text, replyToken) {
    if (text.startsWith('/イベント作成')) {
          const parts = text.split(' ');
          const eventName = parts[1] || 'イベント';
          const date = parts[2] || new Date().toISOString().slice(0, 10);
          const tagId = `${eventName}_${date}`;

      await saveEventToSheet(tagId, eventName, date, userId);
          await broadcastEventAnnouncement(tagId, eventName, date);

      await client.replyMessage(replyToken, {
              type: 'text',
              text: `📢 イベント「${eventName}」を作成し全員に告知しました！\nタグID: ${tagId}\n日付: ${date}`
      });
          return true;
    }

  if (text.startsWith('/送信')) {
        const parts = text.split(' ');
        const tagId = parts[1];
        const message = parts.slice(2).join(' ');
        if (!tagId || !message) {
                await client.replyMessage(replyToken, { type: 'text', text: '使い方: /送信 タグID メッセージ' });
                return true;
        }
        const count = await sendToTag(tagId, message);
        await client.replyMessage(replyToken, { type: 'text', text: `✅ 送信完了！\n対象: ${count}名\nタグ: ${tagId}` });
        return true;
  }

  if (text.startsWith('/全員送信')) {
        const message = text.replace('/全員送信', '').trim();
        if (!message) {
                await client.replyMessage(replyToken, { type: 'text', text: '使い方: /全員送信 メッセージ' });
                return true;
        }
        await axios.post('https://api.line.me/v2/bot/message/broadcast',
                         { messages: [{ type: 'text', text: message }] },
                         { headers: { Authorization: `Bearer ${process.env.TOKEN}` } }
                             );
        await client.replyMessage(replyToken, { type: 'text', text: '✅ 全員に送信しました！' });
        return true;
  }

  if (text.startsWith('/参加者一覧')) {
        const tagId = text.split(' ')[1];
        if (!tagId) {
                await client.replyMessage(replyToken, { type: 'text', text: '使い方: /参加者一覧 タグID' });
                return true;
        }
        const list = await getParticipantList(tagId);
        await client.replyMessage(replyToken, { type: 'text', text: list });
        return true;
  }

  if (text === '/コマンド一覧') {
        await client.replyMessage(replyToken, {
                type: 'text',
                text: '📋 管理者コマンド一覧\n\n' +
                          '/イベント作成 [名前] [日付]\n例: /イベント作成 晩御飯会 2026-06-15\n\n' +
                          '/送信 [タグID] [メッセージ]\n例: /送信 晩御飯会_2026-06-15 明日18時集合です\n\n' +
                          '/全員送信 [メッセージ]\n\n' +
                          '/参加者一覧 [タグID]'
        });
        return true;
  }

  return false;
}

// --- Google Sheets: Save Member ---
async function saveToSheet(lineUserId, data) {
    if (!SPREADSHEET_ID) return;
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/%E3%83%A1%E3%83%B3%E3%83%90%E3%83%BC%E7%AE%A1%E7%90%86!A:G:append?valueInputOption=USER_ENTERED`;
    try {
          await axios.post(url,
                           { values: [[now, lineUserId, data.studentId, data.name, data.email, '', '未確認']] },
                           { headers: { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
                               );
    } catch (e) { console.error('Sheet write error:', e.message); }
}

// --- Google Sheets: Save Event ---
async function saveEventToSheet(tagId, eventName, date, createdBy) {
    if (!SPREADSHEET_ID) return;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/EventManagement!A:F:append?valueInputOption=USER_ENTERED`;
    try {
          await axios.post(url,
                           { values: [[tagId, eventName, date, 0, '', createdBy]] },
                           { headers: { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
                               );
    } catch (e) { console.error('Event sheet write error:', e.message); }
}

// --- Add Tag to User ---
async function addTagToUser(lineUserId, tagId) {
    if (!SPREADSHEET_ID) return;
    // Update EventTags column in member sheet (simplified: append to existing)
  console.log(`Tag added: ${lineUserId} -> ${tagId}`);
    // Full implementation requires reading current tags and updating the row
}

// --- Get Participants by Tag ---
async function sendToTag(tagId, message) {
    if (!SPREADSHEET_ID) return 0;
    // Read members with this tag and multicast
  // Simplified version - full implementation reads sheet and filters
  console.log(`Sending to tag: ${tagId}`);
    return 0;
}

// --- Participant List ---
async function getParticipantList(tagId) {
    return `📋 ${tagId} の参加者一覧\n（スプレッドシートでご確認ください）`;
}

// --- Broadcast Event Announcement ---
async function broadcastEventAnnouncement(tagId, eventName, date) {
    const text = `📣 新しいイベントのお知らせ\n\n🎉 【${eventName}】\n📅 ${date}\n\n参加希望の方はボタンを押してください！`;
    try {
          await axios.post('https://api.line.me/v2/bot/message/broadcast',
                           {
                                     messages: [{
                                                 type: 'template',
                                                 altText: `【${eventName}】参加希望はこちら`,
                                                 template: {
                                                               type: 'confirm',
                                                               text: text,
                                                               actions: [
                                                                 { type: 'postback', label: '✅ 参加する', data: `action=join&tagId=${tagId}&eventName=${encodeURIComponent(eventName)}` },
                                                                 { type: 'postback', label: '❌ 参加しない', data: `action=decline&tagId=${tagId}` }
                                                                             ]
                                                 }
                                     }]
                           },
                           { headers: { Authorization: `Bearer ${process.env.TOKEN}` } }
                               );
    } catch (e) { console.error('Broadcast error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OGM Bot running on port ${PORT}`));
