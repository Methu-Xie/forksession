#!/bin/bash
# patch-dsh-deepseek-sessionid.sh — 本地热修: deepseek 适配器 session-id HTTP 头需 ASCII
# 症状: 中/非 ASCII 会话 id → new Headers() 抛 ByteString 错误 → 被包装成 "DeepSeek Messages transport failed" (TRANSPORT)
# 复跑时机: 每次 dsh 升级/重装后重新执行本脚本（幂等）
set -e
F="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"
[ -f "$F" ] || { echo "未找到适配器: $F"; exit 1; }
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '"x-deepseek-harness-session-id": String(options.sessionId)'
new = '"x-deepseek-harness-session-id": encodeURIComponent(String(options.sessionId))'
if new in s:
    print('已是补丁状态, 跳过')
elif old in s:
    open(p, 'w').write(s.replace(old, new))
    print('补丁已应用:', p)
else:
    print('锚点未找到——dsh 版本可能已变, 需人工核对')
PY
