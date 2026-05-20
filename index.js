/ =============================================================
// OGM公式 LINE Bot  (Plan A: OA Manager タグ手動運用版)
//
// 役割分担:
//   Bot  → 登録受付・イベント告知・Botコマンド
//   OA Manager → タグ付け・タグ絞り込み配信 (手動)
// =============================================================

const express   = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');

const app = express();

// ── LINE / AI クライアント ────────────────────────────────────
const lineConfig = {
      channelSecret:      process.env.SECRET,
      channelAccessToken: process.env.TOKEN,
};
const client    = new Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 定数 ─────────────────────────────────────────────────────
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const LINE_TOKEN     = process.env.TOKEN || '';

// ── 登録フロー用セッション (メモリ) ──────────────────────────
// 本番で複数インスタンスに増やす場合は Redis 等に移行してください
const sessions = new Map(); // { userId: { step, data } }

// =============================================================
// Webhook エントリポイント
// =============================================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
      res.status(200).end();
      for (const event of req.body.events) {
              try {
                        if (event.type === 'follow')                                      await onFollow(event);
                        else if (event.type === 'message' && event.message.type === 'text') await onMessage(event);
                        else if (event.type === 'postback')                               await onPostback(event);
              } catch (e) {
                        console.error('Event error:', e.message);
              }
      }
});

// =============================================================
// フォロー時 → あいさつ + 登録案内
// =============================================================
async function onFollow(event) {
      const msg = process.env.GREETING_MESSAGE ||
              'OGM公式LINEへようこそ！🎉\n\n' +
              '大阪公立大学の国際交流団体 OGM です。\n\n' +
              '「登録」と送ってメンバー登録してください📝';
      await reply(event.replyToken, msg);
}

// =============================================================
// テキストメッセージ受信
// =============================================================
async function onMessage(event) {
      const userId = event.source.userId;
      const text   = event.message.text.trim();

  // ① 管理者コマンド (最優先)
  if (ADMIN_IDS.includes(userId)) {
          const done = await handleAdmin(userId, text, event.replyToken);
          if (done) return;
  }

  // ② 登録フロー継続中
  if (sessions.has(userId)) {
          await handleRegistration(userId, text, event.replyToken);
          return;
  }

  // ③ 登録開始トリガー
  if (['登録', '参加登録', '登録する'].includes(text)) {
          sessions.set(userId, { step: 'student_id', data: {} });
          await reply(event.replyToken,
                            '📝 メンバー登録を開始します！\n\n' +
                            'まず学籍番号を入力してください\n（例: k24001234）');
          return;
  }

  // ④ AI 汎用応答
  const systemPrompt = process.env.SYSTEM_PROMPT ||
          'あなたはOGM（大阪公立大学国際交流団体）の公式LINEアシスタントです。親切・簡潔に日本語で答えてください。';
      const resp = await anthropic.messages.create({
              model:      'claude-opus-4-5',
              max_tokens: 512,
              system:     systemPrompt,
              messages:   [{ role: 'user', content: text }],
      });
      await reply(event.replyToken, resp.content[0].text);
}

// =============================================================
// 登録フロー (学籍番号 → 氏名 → メール)
// =============================================================
async function handleRegistration(userId, text, replyToken) {
      const session = sessions.get(userId);

  switch (session.step) {

      case 'student_id': {
                if (!/^[a-zA-Z]\d{6,8}$/.test(text)) {
                            await reply(replyToken, '⚠️ 形式が正しくありません\n例: k24001234\nもう一度入力してください。');
                            return;
                }
                session.data.studentId = text.toLowerCase();
                session.step = 'name';
                await reply(replyToken, '👤 お名前をフルネームで入力してください');
                break;
      }

      case 'name': {
                if (text.length < 2) {
                            await reply(replyToken, '⚠️ お名前を正しく入力してください');
                            return;
                }
                session.data.name = text;
                session.step = 'email';
                await reply(replyToken, '📧 メールアドレスを入力してください');
                break;
      }

      case 'email': {
                if (!text.includes('@') || !text.includes('.')) {
                            await reply(replyToken, '⚠️ 正しいメールアドレスを入力してください');
                            return;
                }
                session.data.email = text.toLowerCase();
                sessions.delete(userId);

                // スプレッドシートに保存
                await saveToSheet(userId, session.data);

                await reply(replyToken,
                                    '✅ 登録完了！\n\n' +
                                    `📋 学籍番号: ${session.data.studentId}\n` +
                                    `👤 氏名: ${session.data.name}\n` +
                                    `📧 メール: ${session.data.email}\n\n` +
                                    'OGMへようこそ！🎉\nイベント情報をお楽しみに！');
                break;
      }
  }
}

// =============================================================
// ポストバック (イベント参加ボタン)
// =============================================================
async function onPostback(event) {
      const userId = event.source.userId;
      const params = new URLSearchParams(event.postback.data);
      const action    = params.get('action');
      const eventName = params.get('event') || 'イベント';

  if (action === 'join') {
          // スプレッドシートに参加意向を記録
        await recordEventJoin(userId, eventName);
          await reply(event.replyToken,
                            `✅ 【${eventName}】への参加希望を受け付けました！\n\n` +
                            '管理者が確認後、詳細をお送りします。\n' +
                            '※ OA Manager でタグが付与されます。');

  } else if (action === 'decline') {
          await reply(event.replyToken, 'またの機会にぜひ参加してください！😊');
  }
}

// =============================================================
// 管理者コマンド
// =============================================================
async function handleAdmin(userId, text, replyToken) {

  // ── /告知 イベント名 日付 ─────────────────────────────────
  // 例: /告知 晩御飯会 2026-06-15
  if (text.startsWith('/告知')) {
          const parts     = text.split(' ');
          const eventName = parts[1] || 'イベント';
          const date      = parts[2] || '日程未定';
          await broadcastEventCard(eventName, date);
          await reply(replyToken,
                            `📢 【${eventName}】の告知を全員に送信しました！\n` +
                            `参加者には OA Manager でタグ「${eventName}」を付けてください。`);
          return true;
  }

  // ── /全員 メッセージ ──────────────────────────────────────
  // 例: /全員 明日18時に集合です
  if (text.startsWith('/全員')) {
          const message = text.replace('/全員', '').trim();
          if (!message) {
                    await reply(replyToken, '使い方: /全員 メッセージ本文');
                    return true;
          }
          await broadcastText(message);
          await reply(replyToken, '✅ 全員にメッセージを送信しました！');
          return true;
  }

  // ── /登録者 ───────────────────────────────────────────────
  if (text === '/登録者') {
          const count = await getMemberCount();
          await reply(replyToken,
                            `📊 登録者数: ${count}名\n\nスプレッドシートで詳細を確認できます。`);
          return true;
  }

  // ── /ヘルプ ───────────────────────────────────────────────
  if (text === '/ヘルプ' || text === '/help') {
          await reply(replyToken,
                            '📋 管理者コマンド一覧\n\n' +
                            '─ イベント告知 ─\n' +
                            '/告知 [イベント名] [日付]\n' +
                            '例: /告知 晩御飯会 2026-06-15\n\n' +
                            '─ 全員送信 ─\n' +
                            '/全員 [メッセージ]\n' +
                            '例: /全員 明日18時に集合！\n\n' +
                            '─ 確認 ─\n' +
                            '/登録者 → 登録人数を確認\n\n' +
                            '💡 タグ付け・タグ絞り込み配信は\n' +
                            'OA Manager のチャット画面から！');
          return true;
  }

  return false; // コマンド非該当 → AI 応答へ
}

// =============================================================
// Google Sheets 書き込み
// =============================================================
async function saveToSheet(lineUserId, data) {
      if (!SPREADSHEET_ID) { console.warn('SPREADSHEET_ID が未設定です'); return; }
      const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}` +
                        `/values/%E3%83%A1%E3%83%B3%E3%83%90%E3%83%BC%E7%AE%A1%E7%90%86!A:G:append` +
                        `?valueInputOption=USER_ENTERED`;
      try {
              await axios.post(url,
                               { values: [[now, lineUserId, data.studentId, data.name, data.email, '', '未確認']] },
                               { headers: { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
                                   );
              console.log('Sheet saved:', data.studentId);
      } catch (e) {
              console.error('Sheet write error:', e.response?.data || e.message);
      }
}

async function recordEventJoin(lineUserId, eventName) {
      if (!SPREADSHEET_ID) return;
      const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}` +
                        `/values/EventManagement!A:F:append?valueInputOption=USER_ENTERED`;
      try {
              await axios.post(url,
                               { values: [[eventName, lineUserId, now, '参加希望', '', '']] },
                               { headers: { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
                                   );
      } catch (e) {
              console.error('Event join record error:', e.message);
      }
}

async function getMemberCount() {
      if (!SPREADSHEET_ID) return '?';
      try {
              const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}` +
                                  `/values/%E3%83%A1%E3%83%B3%E3%83%90%E3%83%BC%E7%AE%A1%E7%90%86!A:A`;
              const resp = await axios.get(url,
                                           { headers: { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}` } }
                                               );
              const rows = resp.data.values || [];
              return Math.max(0, rows.length - 1); // ヘッダー行を除く
      } catch (e) {
              console.error('getMemberCount error:', e.message);
              return '?';
      }
}

// =============================================================
// LINE Broadcast ヘルパー
// =============================================================

// イベント告知カード (参加/不参加ボタン付き)
async function broadcastEventCard(eventName, date) {
      const announcementText =
              `📣 イベントのお知らせ\n\n` +
              `🎉 【${eventName}】\n` +
              `📅 ${date}\n\n` +
              `参加希望の方はボタンを押してください！`;
      try {
              await axios.post('https://api.line.me/v2/bot/message/broadcast',
                               {
                                           messages: [{
                                                         type:    'template',
                                                         altText: `【${eventName}】参加希望はこちら`,
                                                         template: {
                                                                         type: 'confirm',
                                                                         text: announcementText,
                                                                         actions: [
                                                                             {
                                                                                                 type:  'postback',
                                                                                                 label: '✅ 参加する',
                                                                                                 data:  `action=join&event=${encodeURIComponent(eventName)}`,
                                                                             },
                                                                             {
                                                                                                 type:  'postback',
                                                                                                 label: '❌ 参加しない',
                                                                                                 data:  `action=decline&event=${encodeURIComponent(eventName)}`,
                                                                             },
                                                                                         ],
                                                         },
                                           }],
                               },
                               { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
                                   );
      } catch (e) {
              console.error('Broadcast card error:', e.response?.data || e.message);
      }
}

// テキスト全員送信
async function broadcastText(message) {
      try {
              await axios.post('https://api.line.me/v2/bot/message/broadcast',
                               { messages: [{ type: 'text', text: message }] },
                               { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
                                   );
      } catch (e) {
              console.error('Broadcast text error:', e.response?.data || e.message);
      }
}

// =============================================================
// 共通 reply ヘルパー
// =============================================================
async function reply(replyToken, text) {
      await client.replyMessage(replyToken, { type: 'text', text });
}

// =============================================================
// サーバー起動
// =============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OGM Bot listening on port ${PORT}`));
