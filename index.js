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
