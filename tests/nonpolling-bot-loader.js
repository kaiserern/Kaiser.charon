// Manual operational verification only: real Telegram transport without polling.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/telegram/bot.js')) return {format:'module',shortCircuit:true,source:`import TelegramBot from 'node-telegram-bot-api'; import { TELEGRAM_BOT_TOKEN } from '../config.js'; export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN,{polling:false,request:{timeout:15000}});`};
  return nextLoad(url,context);
}
