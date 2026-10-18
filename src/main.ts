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
      console.log(`本機設定與個性資料檢查通過；上下文上限 ${config.claude.contextTokens} tokens（含輸出預留）。尚未驗證外部服務。`);
    } else {
      const engine = new ChatEngine({ claude: config.claude, system });
      bot = new ChatBot({ config, engine, log: code => console.log(`[NekoChat] ${code}`) });
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
