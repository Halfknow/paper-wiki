const { spawn } = require('child_process');

/** 本项目唯一的子进程模块：调用 `claude -p` CLI 把自然语言（尤其是中文主题）
 *  转成 arXiv 检索式 / 主题说明。
 *
 *  设计取舍：
 *  - 用 spawn（不用 exec/execSync）：不走 shell，避免 Windows/Unix 引号差异；prompt 作为独立 argv 传入。
 *  - 超时用进程级 kill + 自维护 timer，而非 AbortSignal（spawn 不支持）。
 *  - 不抛错：无论 claude 缺失（ENOENT / exit 127）、超时、还是输出非法，都返回结构化结果，
 *    由上层 buildDiscoveryQuery 据此决定是否回退到「原始检索」。这样没装 claude 的环境也能用本功能。
 *
 *  返回 { ok, stdout, stderr, code, reason }：
 *    - ok: true 表示拿到 stdout（即便可能有 stderr 警告）；false 表示任何失败情形
 *    - reason: 'not_found' | 'timeout' | 'nonzero' | 'error' | null，便于上层给用户准确提示
 */
function runClaude(prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const cwd = opts.cwd;
  const cmd = opts.cmd || 'claude';
  return new Promise((resolve) => {
    let child;
    try {
      // --output-format json：claude 输出单行 JSON {result, ...}，便于稳定取 result 字段
      child = spawn(cmd, ['-p', '--output-format', 'json', prompt], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      // 同步抛错（最常见是 ENOENT：PATH 里没有 claude）
      resolve({ ok: false, stdout: '', stderr: String(e && e.message), code: null, reason: 'not_found' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出则忽略 */
      }
      resolve({ ok: false, stdout, stderr, code: null, reason: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 'spawn Error: not found' 在 Windows 也会以 error 事件形式抛出（而非同步 throw）
      const reason = /ENOENT|not found|not recognized/i.test(e.message) ? 'not_found' : 'error';
      resolve({ ok: false, stdout, stderr: stderr + String(e.message), code: null, reason });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // exit code 127 是 shell「command not found」约定；部分平台 ENOENT 会走到这里 code=127
      if (code === 127) {
        resolve({ ok: false, stdout, stderr, code, reason: 'not_found' });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, stdout, stderr, code, reason: 'nonzero' });
        return;
      }
      resolve({ ok: true, stdout, stderr, code, reason: null });
    });
  });
}

module.exports = { runClaude };
