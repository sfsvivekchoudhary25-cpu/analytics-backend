const { NestFactory } = require('@nestjs/core');
require('dotenv').config();
const { AppModule } = require('./dist/app.module');
const { CommentDmService } = require('./dist/comment-dm/comment-dm.service');

async function test() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log', 'debug'] });
  const service = app.get(CommentDmService);

  const payload = {
    object: 'instagram',
    entry: [
      {
        id: '17841441162814542',
        messaging: [
          {
            sender: { id: '1109703051511954' },
            recipient: { id: '17841441162814542' },
            timestamp: Date.now(),
            postback: {
              title: "I'm following ✅",
              payload: 'CONFIRM_FOLLOW',
            },
          },
        ],
      },
    ],
  };

  console.log('--- CALLING handleMessageWebhook WITH POSTBACK ---');
  await service.handleMessageWebhook(payload);
  console.log('--- DONE ---');
  await app.close();
}

test().catch(console.error);
