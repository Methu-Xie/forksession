// lib/tools.js — ToolLayer: 文件/命令执行 + 权限策略（除系统级外全开放）
// Token 优化: 所有工具返回做了长度收敛，避免大块文本灌入上下文。
import { WORKDIR } from './config.js';
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// 统一返回长度上限（token 友好: 给足信息密度，但不让大文件/长命令占满上下文）
const MAX_FILE_CHARS = 3200;     // readFile 返回上限
const MAX_CMD_CHARS = 3200;      // execCommand 返回上限
const MAX_DIR_ENTRIES = 60;      // listDir 最多列条数

// 系统级命令黑名单（命中 → 需飞书审批 / 拒绝）
const SYSTEM_LEVEL_PATTERNS = [
  /\bsudo\b/, /\bapt(\s|-|$)/, /\bapt-get\b/, /\bdnf\b/, /\byum\b/, /\bpacman\b/,
  /\bsystemctl\b/, /\bjournalctl\b/, /\bservice\b/, /\bshutdown\b/, /\breboot\b/,
  /\bpoweroff\b/, /\bpasswd\b/, /\buseradd\b/, /\buserdel\b/, /\bgroupadd\b/,
  /\bfdisk\b/, /\bmkfs\b/, /\bmount\b/, /\bumount\b/,
  /\bnpm\s+install\s+-g\b/, /\bpnpm\s+add\s+-g\b/, /\bpip\s+install\b/, /\bpip3\s+install\b/,
  /\bchmod\s+\d{3,4}\s+\/etc\b/, /\brm\s+-rf\s+\//, /\brm\s+-rf\s+~\/?\s*$/, /\bdd\s+of=/,
  /\bupdate-alternatives\b/, /\balternatives\b/, /\bgrub\b/, /\bkernel\b/i,
];

export function isSystemLevel(command) {
  return SYSTEM_LEVEL_PATTERNS.some((re) => re.test(command));
}

// 通用截断: 保留头部 + 尾部，中间折叠
function clip(text, max, headRatio = 0.6) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * headRatio);
  const keepTail = max - head;
  return `${s.slice(0, head)}\n… [已省略 ${s.length - max} 字符，共 ${s.length}] …\n${s.slice(-keepTail)}`;
}

// ---- 工具实现 ----

export async function readFile({ path: p }) {
  try {
    const content = await fs.readFile(p, 'utf-8');
    return clip(content, MAX_FILE_CHARS);
  } catch (e) {
    return `(读取失败: ${e.message})`;
  }
}

export async function listDir({ path: p }) {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    const lines = entries.slice(0, MAX_DIR_ENTRIES).map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
    return lines.join('\n') + (entries.length > MAX_DIR_ENTRIES ? `\n... (共 ${entries.length} 项)` : '');
  } catch (e) {
    return `(列目录失败: ${e.message})`;
  }
}

export async function writeFile({ path: p, content }) {
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
    return `已写入 ${p} (${content.length} 字符)`;
  } catch (e) {
    return `(写入失败: ${e.message})`;
  }
}

export async function execCommand({ command }) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: process.env.DSH_WORKDIR || WORKDIR,
    });
    const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim();
    return out ? clip(out, MAX_CMD_CHARS) : '(命令无输出)';
  } catch (e) {
    return `(执行失败: ${e.message})`;
  }
}

// ---- 工具注册表（供 agent loop 使用） ----

export const TOOLS = [
  {
    name: 'read_file',
    description: '读取文本文件内容（UTF-8）。参数: path 文件绝对路径',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: readFile,
  },
  {
    name: 'list_dir',
    description: '列出目录内容。参数: path 目录绝对路径',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: listDir,
  },
  {
    name: 'write_file',
    description: '写入/创建文本文件（UTF-8）。参数: path 文件绝对路径, content 内容',
    parameters: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    run: writeFile,
  },
  {
    name: 'exec_command',
    description: '执行 shell 命令（非系统级）。参数: command 命令字符串',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: execCommand,
    needsApproval: isSystemLevel,
  },
];

export async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `(未知工具: ${name})`;
  if (tool.needsApproval && tool.needsApproval(args?.command || '')) {
    return { needsApproval: true, command: args.command };
  }
  return tool.run(args ?? {});
}
