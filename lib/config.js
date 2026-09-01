// lib/config.js — 本地配置集中入口（脱敏边界）
// 真实本地值放插件根的 config.local.json（.gitignore 忽略）; 仓库只含占位默认。
// 优先级: config.local.json > 环境变量 > 占位默认
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const local = (() => {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.local.json'), 'utf8')); } catch { return {}; }
})();
const env = process.env;
const pick = (v, ...fallbacks) => (v ?? fallbacks.find((x) => x !== undefined));

export const HOME = env.HOME || '/home/user';
// 工作目录（工具调用/文件产出的落点）
export const WORKDIR = pick(local.workdir, env.DSH_FEISHU_WORKDIR, HOME);
// 飞书应用（appSecret 走 env DSH_FEISHU_APP_SECRET, 不落任何文件）
export const APP_ID = pick(local.appId, env.DSH_FEISHU_APP_ID, 'cli_YOUR_FEISHU_APP_ID');
export const ALLOWED_USERS = pick(local.allowedUsers, env.DSH_FEISHU_ALLOWED_USERS, '');
// L1 主干会话（feishusession 等; 也可用 main-session.json / /setmain 热切换）
export const MAIN_SESSION_ID = pick(local.mainSessionId, env.DSH_FEISHU_MAIN_SESSION, null);
// 静态树叶 → 既有会话 override（如 forksession 叶 → Web 专用开发会话）
export const LEAF_OVERRIDES = local.leafOverrides || {};
// L2 工作区根（树叶会话 cwd 落位处）
export const LEAF_WS_ROOT = pick(local.leafWsRoot, env.DSH_FEISHU_LEAF_WS_ROOT, join(HOME, 'FeishuTree'));
// DSH 本地存储（workspace.json 所在）
export const DSH_STORAGES = pick(local.dshStorages, env.DSH_HOME && join(env.DSH_HOME, 'storages'), join(HOME, '.dsh', 'storages'));
export const WS_JSON = join(DSH_STORAGES, 'workspace.json');
// 插件运行时状态文件（均 git 忽略）
export const REGISTRY_FILE = join(PLUGIN_DIR, 'session-registry.json');
export const BRANCHES_FILE = join(PLUGIN_DIR, 'branches.json');
export const MAIN_SESSION_FILE = join(PLUGIN_DIR, 'main-session.json');
export const LAST_ACTIVE_FILE = join(PLUGIN_DIR, 'last-active.json');
export const LOG_FILE = join(PLUGIN_DIR, 'plugin.log');
// hermes .env（DeepSeek key 的兜底读取处; 脱敏默认空）
export const HERMES_ENV_FILE = pick(local.hermesEnvFile, env.DSH_HERMES_ENV_FILE, '');
