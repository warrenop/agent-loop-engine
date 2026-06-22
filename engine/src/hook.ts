/**
 * Host 侧 hook 入口:在客户端真正执行探索类工具前自动计数,把 INVESTIGATE 探索预算
 * 从「agent 自报 loop_budget」升级为「host 自动计数」——预算才真正咬得住。
 *
 * 按 stdin 的 `hook_event_name` 自动识别两种宿主契约:
 *  - Claude Code `PreToolUse`         tool_name = Read/Grep/Glob,可 additionalContext 提醒或 deny 阻断
 *  - Cursor `beforeReadFile`          只能数文件读取;只支持 user_message / deny(无 agent_message)
 *  - Cursor `beforeShellExecution`    best-effort 数终端 grep/rg/find;支持 agent_message / deny
 *
 * 失败一律 fail-open:任何异常 / 不适用输入 → exit 0、无输出、绝不阻断工具。
 * 模式:环境变量 AGENT_LOOP_BUDGET_ENFORCE = "warn"(默认,仅提醒)| "block"(超限直接拦)。
 *
 * 注意(Cursor 限制):Cursor 的原生 codebase 搜索/grep 不是 shell 命令、无对应 hook,
 * 因此 Cursor 下只能自动计数「文件读取」(与经 beforeShellExecution 的终端 grep);
 * 原生搜索仍需 agent 手动 loop_budget 补报。
 */
import { getActiveState, bumpUsage, saveState } from "./state.js";

const CC_TOOL_MAP: Record<string, string> = { Read: "read", Grep: "grep", Glob: "glob" };

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

/** best-effort:把终端里的 grep/rg/find 归为探索类 */
function classifyShellTool(cmd: string): string | null {
  if (/\b(rg|grep|egrep|fgrep|ag)\b/.test(cmd)) return "grep";
  if (/\bfind\b/.test(cmd)) return "glob";
  return null;
}

export async function runHook(): Promise<void> {
  let out = "";
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    const ev = input.hook_event_name;
    const block = (process.env.AGENT_LOOP_BUDGET_ENFORCE || "warn").toLowerCase() === "block";

    let key: string | null = null;
    let host: "cc" | "cursor-read" | "cursor-shell" | null = null;
    if (ev === "PreToolUse") {
      key = CC_TOOL_MAP[input.tool_name] || null;
      host = "cc";
    } else if (ev === "beforeReadFile") {
      key = "read";
      host = "cursor-read";
    } else if (ev === "beforeShellExecution") {
      key = classifyShellTool(String(input.command || ""));
      host = "cursor-shell";
    }
    if (!key || !host) return void process.exit(0);

    // 用宿主提供的 cwd / workspace 定位 .agent-loop(否则回退到进程 cwd)
    const root =
      input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null);
    if (root) process.env.AGENT_LOOP_ROOT = root;

    const state = await getActiveState();
    // 预算只在 INVESTIGATE 阶段生效;其它阶段静默放行(不计数)
    if (!state || state.phase !== "INVESTIGATE") return void process.exit(0);

    bumpUsage(state, key, 1);
    await saveState(state);

    const limit = state.budgets[key];
    const used = state.used[key] || 0;
    if (limit === undefined || used <= limit) return void process.exit(0);

    const reason = `Agent Loop 探索预算超限:${key} ${used}/${limit}。停止散读,把已有发现写进 context-map,然后 loop_advance 到 PLAN。`;
    if (host === "cc") {
      out = JSON.stringify({
        hookSpecificOutput: block
          ? {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            }
          : { hookEventName: "PreToolUse", additionalContext: "⚠️ " + reason },
      });
    } else if (host === "cursor-shell") {
      out = JSON.stringify({ permission: block ? "deny" : "allow", agent_message: "⚠️ " + reason });
    } else {
      // cursor-read:beforeReadFile 不支持 agent_message,只能 user_message / deny
      out = JSON.stringify({ permission: block ? "deny" : "allow", user_message: "⚠️ " + reason });
    }
  } catch {
    out = ""; // fail-open
  }
  if (out) process.stdout.write(out);
  process.exit(0);
}
