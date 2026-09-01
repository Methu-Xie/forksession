// lib/run.mjs — 独立运行入口（验证用）
import { run } from './index.js';

run().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
