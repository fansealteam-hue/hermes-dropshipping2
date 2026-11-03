import "dotenv/config";

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number),
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
  miniAppUrl: process.env.MINI_APP_URL ?? "http://localhost:3000",
  nodeEnv: process.env.NODE_ENV ?? "development",
};

export function isAllowed(chatId: number): boolean {
  if (config.nodeEnv === "test") return true;
  if (config.allowedChatIds.length === 0) return false;
  return config.allowedChatIds.includes(chatId);
}
