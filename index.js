// ==========================================================
// OGM公式 LINE Bot  (Plan A: OA Manager タグ手動運用版)
// 最適化版: axios削除 / callClaude()共通化 / SDK一本化
// ==========================================================

const express   = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

// ── クライアント ────────────────────────────────────────
const lineConfig = {
  channelSecret:      process.env.SECRET,
  channelAccessToken: process.env.TOKEN,
};
const client    = new Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 定数 ───────────────────────────────────────────────
const ADMIN_IDS     = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'あなたはOGM公式LINEのAIアシスタントです。';
const GREETING_MSG  = process.env.GREETING_MESSAGE || 'OGMへようこそ！';
const SHEET_ID      = process.env.SPREADSHEET_ID || '';

// ── 登録セッション（メモリ）────────────────────────────
const sessions = new Map(); // userId -> { step, data }

// ==========================================================
// Webhook
// ==========================================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (e) { console.error('Event error:', e.message); }
  }
});

// ==========================================================
// イベント振り分け
// ==========================================================
async function handleEvent(event) {
  const { type, source, message } = event;
  const userId = source?.userId;

  if (type === 'follow') {
    return reply(event.replyToken, GREETING_MSG);
  }

  if (type === 'postback') {
    return handlePostback(event);
  }

  if (type !== 'message' || message?.type !== 'text') return;

  const text = message.text.trim();

  // 管理者コマンド
  if (ADMIN_IDS.includes(userId) && text.startsWith('/')) {
    return handleAdminCommand(userId, text, event.replyToken);
  }

  // 登録フロー中
  if (sessions.has(userId)) {
    return handleRegistration(userId, text, event.replyToken);
  }

  // 登録トリガー
  if (/^(登録|参加登録|登録する|メンバー登録)$/.test(text)) {
    sessions.set(userId, { step: 'studentId', data: {} });
    return reply(event.replyToken, '📝 登録を開始します！\n\nまず学籍番号を入力してください。\n（例: k24001234）');
  }

  // AIフォールバック
  const aiReply = await callClaude(text).catch(() => '少し考えさせてください。もう一度メッセージを送ってみてください。');
  return reply(event.replyToken, aiReply);
}

// ==========================================================
// 登録フロー
// ==========================================================
async function handleRegistration(userId, text, replyToken) {
  const session = sessions.get(userId);

  if (session.step === 'studentId') {
    if (!/^[a-zA-Z]\d{6,8}$/.test(text)) {
      return reply(replyToken, '⚠️ 学籍番号の形式が正しくありません。\n英字1文字＋数字6〜8桁で入力してください。\n例: k24001234');
    }
    session.data.studentId = text;
    session.step = 'name';
    return reply(replyToken, '✅ 学籍番号を受け付けました。\n\n次に、氏名（フルネーム）を入力してください。');
  }

  if (session.step === 'name') {
    if (text.length < 2 || text.length > 30) {
      return reply(replyToken, '⚠️ 氏名は2〜30文字で入力してください。');
    }
    session.data.name = text;
    session.step = 'email';
    return reply(replyToken, `✅ ${text} さん、ありがとうございます。\n\n最後に、大学のメールアドレスを入力してください。`);
  }

  if (session.step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return reply(replyToken, '⚠️ メールアドレスの形式が正しくありません。再度入力してください。');
    }
    session.data.email = text;
    sessions.delete(userId);
    await saveToSheet(userId, session.data);
    return reply(replyToken, `🎉 登録完了！\n\n【登録情報】\n学籍番号: ${session.data.studentId}\n氏名: ${session.data.name}\nメール: ${session.data.email}\n\nOGMへようこそ！イベントの詳細はこのアカウントからお知らせします✨`);
  }

  sessions.delete(userId);
  return reply(replyToken, 'セッションをリセットしました。もう一度「登録」と送ってください。');
}

// ==========================================================
// 管理者コマンド
// ==========================================================
async function handleAdminCommand(userId, text, replyToken) {
  // /告知 [任意テキスト]
  if (text.startsWith('/告知')) {
    const arg = text.replace('/告知', '').trim();
    await reply(replyToken, '⏳ 告知文を生成中...');
    try {
      const prompt = arg
        ? `以下のイベントについてLINE告知文を作成してください: "${arg}"\nSYSTEM_PROMPTに記載の情報のみ使用し、架空の情報は絶対に追加しないでください。告知文のみを返してください。`
        : 'SYSTEM_PROMPTに記載されている今後のイベントのうち、最も直近のものをLINE告知文にしてください。架空の日程・場所・内容は絶対に追加しないでください。告知文のみを返してください。';
      const announcement = await callClaude(prompt, 800);
      await broadcast(announcement);
      await push(userId, '✅ 告知を配信しました。');
    } catch (e) {
      console.error('/告知 error:', e.message);
      await push(userId, '❌ 告知文の生成に失敗しました: ' + e.message);
    }
    return;
  }

  // /全員 [メッセージ]
  if (text.startsWith('/全員 ')) {
    const msg = text.slice('/全員 '.length).trim();
    if (!msg) return reply(replyToken, '⚠️ メッセージを入力してください。');
    try {
      await broadcast(msg);
      return reply(replyToken, '✅ 全員に配信しました。');
    } catch (e) {
      return reply(replyToken, '❌ 配信失敗: ' + e.message);
    }
  }

  // /登録者
  if (text === '/登録者') {
    const count = await getMemberCount();
    return reply(replyToken, `📊 現在の登録者数: ${count}人`);
  }

  // /イベント
  if (text === '/イベント') {
    try {
      const res = await callClaude('SYSTEM_PROMPTに記載の今後のイベント一覧を、日付・イベント名・場所を含めて教えてください。架空の情報は追加しないでください。', 600);
      return reply(replyToken, res);
    } catch (e) {
      return reply(replyToken, '❌ 取得失敗: ' + e.message);
    }
  }

  // /ヘルプ
  if (text === '/ヘルプ' || text === '/help') {
    return reply(replyToken,
      '📋 管理者コマンド一覧\n' +
      '━━━━━━━━━━━━━━━\n' +
      '/告知          → 直近イベントを告知文に変換して全員に配信\n' +
      '/告知 [内容]   → 指定内容の告知文を全員に配信\n' +
      '/全員 [MSG]    → 全員にテキスト配信\n' +
      '/登録者        → 登録者数を確認\n' +
      '/イベント      → 今後のイベント一覧表示\n' +
      '/ヘルプ        → このヘルプ\n\n' +
      '💡 タグ配信はLINE OA Managerで手動で行ってください'
    );
  }

  return reply(replyToken, '⚠️ 不明なコマンドです。/ヘルプ で一覧を確認できます。');
}

// ==========================================================
// ポストバック（イベント参加ボタン）
// ==========================================================
async function handlePostback(event) {
  const userId = event.source?.userId;
  const params = new URLSearchParams(event.data);
  const action = params.get('action');
  const eventName = params.get('event');

  if (action === 'join') {
    await saveEventJoin(userId, eventName);
    return reply(event.replyToken, `✅ 「${eventName}」への参加を受け付けました！\n詳細はスタッフからご連絡します。参加ありがとうございます😊`);
  }
  if (action === 'decline') {
    return reply(event.replyToken, '残念！またいつでもイベントに参加してください🙌');
  }
}

// ==========================================================
// 共通ヘルパー
// ==========================================================

// Claude AI 呼び出し
async function callClaude(userPrompt, maxTokens = 500) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return res.content[0].text;
}

// LINE返信（replyToken使用）
function reply(replyToken, text) {
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// LINEプッシュ（管理者へのエラー通知など）
function push(userId, text) {
  return client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
}

// LINE全員ブロードキャスト（SDK v9の正しい引数形式）
function broadcast(text) {
  return client.broadcast([{ type: 'text', text }]);
}

// ==========================================================
// Google Sheets（GOOGLE_ACCESS_TOKENが設定されたら有効）
// ==========================================================
async function sheetsAppend(sheetName, values) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) { console.warn('GOOGLE_ACCESS_TOKEN not set — skipping'); return; }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A:Z:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  });
  if (!res.ok) console.error('Sheets error:', await res.text());
}

function saveToSheet(userId, data) {
  return sheetsAppend('メンバー管理', [new Date().toISOString(), userId, data.studentId, data.name, data.email, '', 'active']);
}

function saveEventJoin(userId, eventName) {
  return sheetsAppend('EventManagement', [new Date().toISOString(), userId, eventName]);
}

async function getMemberCount() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) return '(取得不可: 認証未設定)';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('メンバー管理')}!A:A`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) return '(取得失敗)';
  const json = await res.json();
  return Math.max(0, (json.values?.length || 1) - 1);
}

// ==========================================================
// 起動
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OGM Bot listening on port ${PORT}`));
