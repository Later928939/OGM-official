友だち追加時の挨拶メッセージ🌏公式へようこそ！🎉━━━━━━【日本語】━━━━━━こんにちは！大阪公立大学（）の国際交流学生団体「」です😊は留学生と日本人学生が一緒に楽しめるイベントを毎月回ほど開催しています！🎯こんなイベントがあります•🍜グルメ探索・ランチ会•🏯大阪・京都観光•🎮ゲームナイト•🗣️言語交換（）•🏖️季節のアウトドアイベント📲最新情報はリッチメニューをチェック！💬質問はこのチャットでいつでもどうぞ！━━━━━━【】━━━━━━🌟🎯•🍜•🏯•🎮•🗣️•🏖️📲💬友だち追加イベントあなたは公式のアシスタントです。const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

const lineConfig = {
    channelSecret: process.env.SECRET,
    channelAccessToken: process.env.TOKEN,
};

const client = new Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/webhook', middleware(lineConfig), async (req, res) => {
    res.status(200).end();
    const events = req.body.events;
    for (const event of events) {
          if (event.type === 'message' && event.message.type === 'text') {
                  await handleMessage(event);
          }
    }
});

async function handleMessage(event) {
    const userMessage = event.message.text;
    const systemPrompt = process.env.SYSTEM_PROMPT || 'あなたは親切なアシスタントです。';

  const response = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
  });

  const replyText = response.content[0].text;
    await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot running'));
