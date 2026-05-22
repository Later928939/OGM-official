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
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'あなたはOGM公式LINEのAIアシスタントです。';
const GREETING_MSG = process.env.GREETING_MESSAGE || 'OGMへようこそ！';
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
  if (/^(登録|参加登録|登録する|メンバー登録)$/.test(text)) {
    const eventList = await getEventList();
    sessions.set(userId, { step: 'event', data: {} });
    return replyWithQuickReply(event.replyToken,
      '📋 どのイベントに参加しますか？\n\n以下から選択するか、番号を入力してください：',
      eventList
    );
  }

  const aiReply = await callClaude(text).catch(() => '少し考えさせてください。もう一度メッセージを送ってみてください。');
  return reply(event.replyToken, aiReply);
}

async function getEventList() {
  try {
    const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' });
    const prompt = '今日の日付は' + today + 'です。SYSTEM_PROMPTに記載されている今後のイベント（今日以降の日程のもの）を簡潔なリスト形式で返してください。各イベントを「イベント名」のみで1行ずつ列挙してください。最大10件。過去のイベントは含めないでください。';
    const result = await callClaude(prompt, 300);
    const lines = result.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^[0-9]+[.\.]/)).slice(0, 10);
    // 番号付きでフォーマット
    return lines.length > 0 ? lines : ['イベントA', 'イベントB'];
  } catch(e) {
    console.error('getEventList error:', e.message);
    return ['イベントA', 'イベントB'];
  }
}

async function handleRegistration(userId, text, replyToken) {
  const session = sessions.get(userId);

  if (session.step === 'event') {
    const eventList = session.data.eventList || [];
    let chosen = '';
    // 番号で選択
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= eventList.length) {
      chosen = eventList[num - 1];
    } else {
      // テキストで選択（quickReplyのラベルやそのまま入力）
      const match = eventList.find(e => e === text || text.includes(e) || e.includes(text));
      if (match) {
        chosen = match;
      } else {
        const listText = eventList.map((e, i) => (i+1) + '. ' + e).join('\n');
        return reply(replyToken, '⚠️ イベントを選択してください。\n\n' + listText + '\n\n番号または名前で入力してください。');
      }
    }
    session.data.event = chosen;
    session.step = 'studentId';
    return reply(replyToken, '✅ 「' + chosen + '」を選択しました。\n\n次に学籍番号を入力してください。\n（例: AJE25053）');
  }

  if (session.step === 'studentId') {
    if (!/^[a-zA-Z]{3}\d{5}$/.test(text)) {
      return reply(replyToken, '⚠️ 学籍番号の形式が正しくありません。\n英字3文字＋数字5桁で入力してください。\n例: AJE25053');
    }
    session.data.studentId = text.toUpperCase();
    session.step = 'name';
    return reply(replyToken, '✅ 学籍番号を受け付けました。\n\n次に、氏名（フルネーム）を入力してください。');
  }
  if (session.step === 'name') {
    if (text.length < 2 || text.length > 30) {
      return reply(replyToken, '⚠️ 氏名は2〜30文字で入力してください。');
    }
    session.data.name = text;
    session.step = 'email';
    return reply(replyToken, '✅ ' + text + ' さん、ありがとうございます。\n\n最後に、大学のメールアドレスを入力してください。');
  }
  if (session.step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return reply(replyToken, '⚠️ メールアドレスの形式が正しくありません。再度入力してください。');
    }
    session.data.email = text;
    sessions.delete(userId);
    await saveToSheet(userId, session.data);
    return reply(replyToken, '🎉 登録完了！\n\n【ご登録情報】\nイベント: ' + session.data.event + '\n学籍番号: ' + session.data.studentId + '\n氏名: ' + session.data.name + '\nメール: ' + session.data.email + '\n\nOGMへようこそ！イベントの詳細はこのアカウントからお知らせします✨');
  }

  sessions.delete(userId);
  return reply(replyToken, 'セッションをリセットしました。もう一度「登録」と送ってください。');
}

async function handleAdminCommand(userId, text, replyToken) {
  const today = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric'
  });

  if (text.startsWith('/告知')) {
    const arg = text.replace('/告知', '').trim();
    await reply(replyToken, '⏳ 告知文を生成中...');
    try {
      const prompt = arg
        ? '以下のイベントについてLINE告知文を作成してください: "' + arg + '"\n今日の日付は' + today + 'です。SYSTEM_PROMPTに記載の情報のみ使用し、架空の情報は絶対に追加しないでください。告知文のみを返してください。'
        : '今日の日付は' + today + 'です。SYSTEM_PROMPTに記載されている今後のイベント（今日以降の日程のもの）のうち、最も直近のものをLINE告知文にしてください。過去の日付のイベントは絶対に使用しないでください。架空の日程・場所・内容は絶対に追加しないでください。告知文のみを返してください。';
      const announcement = await callClaude(prompt, 800);
      console.log('Broadcasting announcement:', announcement.substring(0, 100));
      await broadcast(announcement);
      await push(userId, '✅ 告知を全員に送信しました。\n\n送信内容:\n' + announcement.substring(0, 150) + (announcement.length > 150 ? '...' : ''));
    } catch (e) {
      console.error('/告知 error:', e.message);
      await push(userId, '❌ 告知文の生成に失敗しました: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/全員 ')) {
    const msg = text.slice('/全員 '.length).trim();
    if (!msg) return reply(replyToken, '⚠️ メッセージを入力してください。');
    try {
      await broadcast(msg);
      await push(userId, '✅ 全員に送信しました: ' + msg.substring(0, 50));
    } catch (e) {
      await push(userId, '❌ 送信失敗: ' + e.message);
    }
    return;
  }

  if (text === '/人数') {
    const count = await getMemberCount();
    return reply(replyToken, '👥 現在のメンバー数: ' + count + '人');
  }

  if (text === '/help' || text === '/ヘルプ') {
    return reply(replyToken,
      '📖 管理者コマンド一覧\n\n' +
      '/告知 - 直近のイベントを全員に告知\n' +
      '/告知 [内容] - 指定内容で告知\n' +
      '/全員 [メッセージ] - 全員にメッセージ送信\n' +
      '/人数 - 登録者数を確認'
    );
  }

  return reply(replyToken, '❓ 不明なコマンドです。/help で一覧を確認できます。');
}

async function handlePostback(event) {
  const userId = event.source && event.source.userId;
  const params = new URLSearchParams(event.data);
  const action = params.get('action');
  const eventName = params.get('event');

  if (action === 'selectEvent' && eventName) {
    const session = sessions.get(userId);
    if (session && session.step === 'event') {
      session.data.event = eventName;
      session.step = 'studentId';
      return reply(event.replyToken, '✅ 「' + eventName + '」を選択しました。\n\n次に学籍番号を入力してください。\n（例: AJE25053）');
    }
  }
}

async function saveToSheet(userId, data) {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  await sheetsAppend('参加者', [
    now,
    userId,
    data.event || '',
    data.studentId || '',
    data.name || '',
    data.email || '',
  ]);
}

async function callClaude(text, maxTokens = 500) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });
  return msg.content[0].text;
}

function reply(replyToken, text) {
  return client.replyMessage(replyToken, [{ type: 'text', text }]);
}

function replyWithQuickReply(replyToken, text, items) {
  const quickReply = {
    items: items.slice(0, 13).map((label, i) => ({
      type: 'action',
      action: {
        type: 'postback',
        label: label.length > 20 ? label.substring(0, 20) : label,
        data: 'action=selectEvent&event=' + encodeURIComponent(label),
        displayText: label,
      }
    }))
  };
  return client.replyMessage(replyToken, [{
    type: 'text',
    text,
    quickReply,
  }]);
}

function push(userId, text) {
  return client.pushMessage(userId, [{ type: 'text', text }]);
}

async function broadcast(text) {
  const friends = await client.getFriends().catch(() => null);
  console.log('broadcast: friends API result:', friends);
  if (!friends) {
    console.log('broadcast: falling back to broadcastMessage');
    return client.broadcast([{ type: 'text', text }]);
  }
  return client.broadcast([{ type: 'text', text }]);
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
  if (!token) return '(取得不可: トークン未設定)';
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/' + encodeURIComponent('参加者') + '!A:A';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!res || !res.ok) return '(取得失敗)';
  const json = await res.json();
  return Math.max(0, (json.values ? json.values.length : 1) - 1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log('OGM Bot listening on port ' + PORT); });
