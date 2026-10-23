// Test-only Telegram transport. Production orchestration and database are real.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/telegram/bot.js')) return {
    format: 'module', shortCircuit: true,
    source: 'export const bot = { sendMessage: async () => ({message_id: 1}), sendPhoto: async () => ({message_id: 2}), on: () => {}, onText: () => {} };'
  };
  return nextLoad(url, context);
}
