// lib/agent-loop.js — AgentLoop: DeepSeek function-calling 对话循环（对齐 hermes conversation_loop）
// Token 优化: 每轮发送前经 context-manager 做预算压缩，限制工具循环次数，避免上下文无脑膨胀。
import { HERMES_ENV_FILE } from './config.js';
import { readFileSync } from 'node:fs';
import { TOOLS, runTool } from './tools.js';
import { compressMessages, ContextConfig } from './context-manager.js';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    if (!HERMES_ENV_FILE) return '';
    const lines = readFileSync(HERMES_ENV_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.startsWith('DEEPSEEK_API_KEY=sk-')) return line.trim().split('=').slice(1).join('=');
    }
  } catch {}
  return '';
}

async function chat(messages, tools) {
  const key = loadKey();
  const body = { model: MODEL, messages, max_tokens: 1200 }; // 输出上限也略微收敛
  if (tools?.length) body.tools = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data.choices[0].message;
}

/**
 * 运行一轮 agent 对话（LLM + 工具循环）。
 * @param {object} opts
 * @param {string} opts.systemPrompt 系统提示
 * @param {string} opts.userMessage 用户消息
 * @param {function} opts.requestApproval async (command) => boolean 系统级命令审批回调
 * @param {function} opts.onToolCall (name, args) => void 工具调用日志
 * @param {number} opts.tokenBudget 输入 token 预算（默认 8000）
 */
export async function runAgentTurn({ systemPrompt, userMessage, requestApproval, onToolCall, tokenBudget }) {
  const budget = tokenBudget ?? ContextConfig.tokenBudget;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  let toolTurns = 0;
  const maxToolTurns = ContextConfig.maxToolTurns; // 合理上限，避免模型空转

  while (toolTurns < maxToolTurns) {
    // 发送前做上下文 token 预算压缩（关键优化点）
    const compact = compressMessages(messages, budget);
    const msg = await chat(compact, TOOLS);
    if (!msg.tool_calls?.length) {
      return msg.content || '(无回复)';
    }
    // 有工具调用: 执行并回填
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      onToolCall?.(name, args);
      let result;
      const tool = TOOLS.find((t) => t.name === name);
      if (tool?.needsApproval && tool.needsApproval(args?.command || '')) {
        if (requestApproval) {
          const ok = await requestApproval(args.command);
          result = ok ? await tool.run(args) : '用户拒绝了该命令的执行。';
        } else {
          result = '该命令需要审批，但审批通道未配置。';
        }
      } else {
        result = await runTool(name, args);
      }
      // 工具结果即使是对象，也先转字符串再入上下文（后续由 context-manager 压缩）
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
    toolTurns++;
  }
  return '(工具循环已到上限，请基于已有信息直接给出结论。)';
}

// 供独立入口使用
export { loadKey };

// 轻量纯文本 LLM 调用（无工具），用于分类/路由等场景
export async function chatText(systemPrompt, userMessage) {
  const msg = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ], null);
  return msg.content || '';
}
