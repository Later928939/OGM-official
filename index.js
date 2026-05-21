// ==========================================================
// OGM公式 LINE Bot  (Plan A: OA Manager タグ手動運用版)
//
// 役割分担:
//   Bot  → 登録受付・イベント告知・Botコマンド
//   OA Manager → タグ付け・タグ絞り込み配信（手動）
//
// 変更点: /告知コマンドはSYSTEM_PROMPTのイベント情報を
//         Claudeが読んで告知文を自動生成する（架空イベントなし）
// ==========================================================

const express    = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic  = require('@anthropic-ai/sdk');
const axios      = require('axios');

const app = express();

// — LINE / AI クライアント ——————————————————————————
const lineConfig = {
  channelSecret:       process.env.SECRET,
  channelAccessToken:  process.env.TOKEN,
};
const client     = new Client(lineConfig);
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// — 定数 ——————————————————————————————————————
const LINE_TOKEN      = process.env.TOKEN || '';
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID || '';
const ADMIN_IDS       = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT   = process.env.SYSTEM_PROMPT || 'あなたはOGM公式LINEのAIアシスタントです。';
const GREETING_MSG    = process.env.GREETING_MESSAGE || 'OGMへようこそ！';

// — 登録セッション（メモリ）———————————————————————
const sessions = new Map(); // userId -> { step, data }

// ==========================================================
// Webhook エンドポイント
// ==========================================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error('Event error:', e.message);
    }
  }
});

// ==========================================================
// イベント振り分け
// ==========================================================
async function handleEvent(event) {
  const { type, source, message, postback } = event;
  const userId = source?.userId;

  if (type === 'follow') {
    await handleFollow(userId, event.replyToken);
    return;
  }

  if (type === 'postback') {
    await handlePostback(event);
    return;
  }

  if (type !== 'message' || message.type !== 'text') return;

  const text = (message.text || '').trim();

  // 管理者コマンド
  if (ADMIN_IDS.includes(userId) && text.startsWith('/')) {
    await handleAdminCommand(userId, text, event.replyToken);
    return;
  }

  // 登録フロー中か確認
  if (sessions.has(userId)) {
    await handleRegistration(userId, text, event.replyToken);
    return;
  }

  // 登録トリガー
  if (/^(登録|参加登録|登録する|メンバー登録)$/.test(text)) {
    sessions.set(userId, { step: 'studentId', data: {} });
    await reply(event.replyToken, '📝 登録を開始します！\n\nまず学籍番号を入力してください。\n（例: k24001234）');
    return;
  }

  // AI フォールバック
  await handleAI(userId, text, event.replyToken);
}

// ==========================================================
// フォロー時挨拶
// ==========================================================
async function handleFollow(userId, replyToken) {
  await reply(replyToken, GREETING_MSG);
}

// ==========================================================
// 登録フロー
// ==========================================================
async function handleRegistration(userId, text, replyToken) {
  const session = sessions.get(userId);

  if (session.step === 'studentId') {
    if (!/^[a-zA-Z]\d{6,8}$/.test(text)) {
      await reply(replyToken, '⚠️ 学籍番号の形式が正しくありません。\n英字1文字＋数字6〜8桁で入力してください。\n例: k24001234');
      return;
    }
    session.data.studentId = text;
    session.step = 'name';
    await reply(replyToken, '✅ 学籍番号を受け付けました。\n\n次に、氏名（フルネーム）を入力してください。');
    return;
  }

  if (session.step === 'name') {
    if (text.length < 2 || text.length > 30) {
      await reply(replyToken, '⚠️ 氏名は2〜30文字で入力してください。');
      return;
    }
    session.data.name = text;
    session.step = 'email';
    await reply(replyToken, `✅ ${text} さん、ありがとうございます。\n\n最後に、大学のメールアドレスを入力してください。`);
    return;
  }

  if (session.step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await reply(replyToken, '⚠️ メールアドレスの形式が正しくありません。再度入力してください。');
      return;
    }
    session.data.email = text;
    sessions.delete(userId);

    // スプレッドシートへ保存
    await saveToSheet(userId, session.data);

    await reply(replyToken, `🎉 登録完了！\n\n【登録情報】\n学籍番号: ${session.data.studentId}\n氏名: ${session.data.name}\nメール: ${session.data.email}\n\nOGMへようこそ！イベントの詳細はこのアカウントからお知らせします✨`);
    return;
  }

  // 不明ステップはリセット
  sessions.delete(userId);
  await reply(replyToken, 'セッションをリセットしました。もう一度「登録」と送ってください。');
}

// ==========================================================
// 管理者コマンド
// ==========================================================
async function handleAdminCommand(userId, text, replyToken) {
  // /告知 → Claudeに「SYSTEM_PROMPTに記載の今後のイベントを告知文にして」と依頼
  // /告知 [イベント名] → 指定イベントの告知文を生成
  if (text.startsWith('/告知')) {
    const arg = text.replace('/告知', '').trim();
    try {
      await reply(replyToken, '⏳ 告知文を生成中...');

      // Claudeに告知文生成を依頼（SYSTEM_PROMPTのイベント情報のみ使用）
      const prompt = arg
        ? `以下のイベントについてLINE告知文を作成してください: "${arg}"\nSYSTEM_PROMPTに記載の情報のみ使用し、架空の情報は絶対に追加しないでください。\n告知文のみを返してください（説明不要）。`
        : 'SYSTEM_PROMPTに記載されている今後のイベントのうち、最も直近のものをLINE告知文にしてください。\n架空の日程・場所・内容は絶対に追加しないでください。\n告知文のみを返してください（説明不要）。';

      const aiRes = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const announcement = aiRes.content[0].text;

      // 全ユーザーへブロードキャスト
      await broadcastText(announcement);
      return;
    } catch (e) {
      console.error('/告知 error:', e.message);
      await push(userId, '❌ 告知文の生成に失敗しました: ' + e.message);
      return;
    }
  }

  // /全員 [メッセージ] → 全員にテキスト配信
  if (text.startsWith('/全員 ')) {
    const msg = text.replace('/全員 ', '').trim();
    if (!msg) { await reply(replyToken, '⚠️ メッセージを入力してください。'); return; }
    try {
      await broadcastText(msg);
      await reply(replyToken, `✅ 全員に配信しました。`);
    } catch (e) {
      await reply(replyToken, '❌ 配信失敗: ' + e.message);
    }
    return;
  }

  // /登録者 → 登録人数
  if (text === '/登録者') {
    const count = await getMemberCount();
    await reply(replyToken, `📊 現在の登録者数: ${count}人`);
    return;
  }

  // /イベント → Claudeが今後のイベント一覧を返す（SYSTEM_PROMPTから）
  if (text === '/イベント') {
    try {
      const aiRes = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'SYSTEM_PROMPTに記載の今後のイベント一覧を、日付・イベント名・場所を含めて教えてください。架空の情報は追加しないでください。' }],
      });
      await reply(replyToken, aiRes.content[0].text);
    } catch (e) {
      await reply(replyToken, '❌ 取得失敗: ' + e.message);
    }
    return;
  }

  // /ヘルプ
  if (text === '/ヘルプ' || text === '/help') {
    await reply(replyToken,
      '📋 管理者コマンド一覧\n' +
      '━━━━━━━━━━━━━━━\n' +
      '/告知          → 直近イベントをClaudeが生成して全員に配信\n' +
      '/告知 [内容]   → 指定内容の告知文をClaudeが生成して全員に配信\n' +
      '/全員 [MSG]    → 全員にテキスト配信\n' +
      '/登録者        → 登録者数を確認\n' +
      '/イベント      → 今後のイベント一覧表示\n' +
      '/ヘルプ        → このヘルプ\n\n' +
      '💡 タグ配信はLINE OA Managerで手動で行ってください'
    );
    return;
  }

  await reply(replyToken, '⚠️ 不明なコマンドです。/ヘルプ で一覧を確認できます。');
}

// ==========================================================
// ポストバック（イベント参加ボタン）
// ==========================================================
async function handlePostback(event) {
  const { data, replyToken } = event;
  const userId = event.source?.userId;
  const params = new URLSearchParams(data);
  const action = params.get('action');
  const eventName = params.get('event');

  if (action === 'join') {
    await saveEventJoin(userId, eventName);
    await reply(replyToken,
      `✅ 「${eventName}」への参加を受け付けました！\n\n詳細はスタッフからご連絡します。\n参加ありがとうございます😊`
    );
    return;
  }

  if (action === 'decline') {
    await reply(replyToken, `残念！またいつでもイベントに参加してください🙌`);
    return;
  }
}

// ==========================================================
// AI フォールバック（SYSTEM_PROMPTを使用）
// ==========================================================
async function handleAI(userId, text, replyToken) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    await reply(replyToken, res.content[0].text);
  } catch (e) {
    console.error('AI error:', e.message);
    await reply(replyToken, '少し考えさせてください。もう一度メッセージを送ってみてください。');
  }
}

// ==========================================================
// ユーティリティ
// ==========================================================
async function reply(replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

async function push(userId, text) {
  await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
}

async function broadcastText(text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/broadcast',
    { messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ==========================================================
// Google Sheets 書き込み
// ==========================================================
async function saveToSheet(userId, data) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) { console.warn('GOOGLE_ACCESS_TOKEN not set — skipping sheet write'); return; }
  const sheetName = encodeURIComponent('メンバー管理');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${sheetName}!A:G:append?valueInputOption=USER_ENTERED`;
  await axios.post(url,
    { values: [[new Date().toISOString(), userId, data.studentId, data.name, data.email, '', 'active']] },
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(e => console.error('Sheets write error:', e.response?.data || e.message));
}

async function saveEventJoin(userId, eventName) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) { console.warn('GOOGLE_ACCESS_TOKEN not set — skipping sheet write'); return; }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/EventManagement!A:F:append?valueInputOption=USER_ENTERED`;
  await axios.post(url,
    { values: [[new Date().toISOString(), userId, eventName, '', '', '']] },
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(e => console.error('Sheets write error:', e.response?.data || e.message));
}

async function getMemberCount() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) return '(取得不可: 認証未設定)';
  const sheetName = encodeURIComponent('メンバー管理');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${sheetName}!A:A`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => null);
  if (!res) return '(取得失敗)';
  return Math.max(0, (res.data.values?.length || 1) - 1);
}

// ==========================================================
// サーバー起動
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OGM Bot listening on port ${PORT}`));
