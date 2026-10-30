import { loadConfig, ConfigError } from './config.js';
import { ChatEngine } from './chat.js';
import { ChatBot } from './bot.js';

const args = process.argv.slice(2);
let filename = 'config.yaml';
let check = false;
let valid = true;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--check') check = true;
  else if (args[index] === '--config' && args[index + 1] && !args[index + 1].startsWith('--')) filename = args[++index];
  else valid = false;
}

if (!valid) {
  console.error('用法：npm start -- [--config 設定檔路徑] [--check]');
  process.exitCode = 1;
} else {
  let bot: ChatBot | undefined;
  let shutdown: (() => void) | undefined;
  try {
    const { config, system } = await loadConfig(filename);
    if (check) {
      const label = (provider: 'openai' | 'claude') => provider === 'openai'
        ? `OpenAI（${config.openai?.model}，圖片 ${config.openai?.imageModel}）` : `Claude（${config.claude?.model}）`;
      const backup = config.provider === 'openai' ? (config.claude ? 'claude' : undefined) : (config.openai ? 'openai' : undefined);
      console.log(`本機設定與個性資料檢查通過；主要使用 ${label(config.provider)}${backup ? `，備用 ${label(backup)}` : '，未設定備用'}。尚未驗證外部服務。`);
      console.log(config.cjkFont ? `CJK 字型：${config.cjkFont.file}` : '找不到 CJK 字型：PDF 附件停用，圖片中的文字可能無法顯示；請安裝 Noto Sans CJK 或設定 cjkFont。');
    } else {
      const log = (code: string) => console.log(`[NekoChat] ${code}`);
      const engine = new ChatEngine({ provider: config.provider, openai: config.openai, claude: config.claude, system, log });
      bot = new ChatBot({ config, engine, log });
      const activeBot = bot;
      shutdown = () => activeBot.stop();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      bot.start();
      await bot.closed;
    }
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : '聊天元件啟動失敗；請確認設定與服務狀態。');
    process.exitCode = 1;
  } finally {
    bot?.stop();
    if (shutdown) {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    }
  }
}
