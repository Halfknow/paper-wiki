// 主题（v3.32 R10）：外观 = 跟随系统 | 浅色 | 深色。
//
// 应用链路：index.html <head> 内联脚本在首帧前写 html[data-theme]（防深色闪白，
// 与 data-boot-path 同一处）；本模块负责运行时切换 + 系统主题变化监听 + 设置面板
// 分段控件的 active 态。持久化 localStorage('pw-theme')：''（跟随系统）/ light / dark。

const MEDIA = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemeChoice() {
  return localStorage.getItem('pw-theme') || '';
}

function resolve(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return MEDIA && MEDIA.matches ? 'dark' : 'light';
}

export function applyTheme(choice) {
  document.documentElement.dataset.theme = resolve(choice);
  // 同步设置面板分段控件 active 态（控件未挂载时跳过）
  document.querySelectorAll('#theme-seg [data-theme-choice]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeChoice === choice);
  });
}

export function setThemeChoice(choice) {
  if (choice === 'light' || choice === 'dark') localStorage.setItem('pw-theme', choice);
  else localStorage.setItem('pw-theme', '');
  applyTheme(choice);
}

/** bind.js 启动时接线：控件点击 + 系统主题变化（仅「跟随系统」态响应用户同步）。 */
export function wireTheme() {
  const seg = document.getElementById('theme-seg');
  if (seg) {
    seg.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.onclick = () => setThemeChoice(b.dataset.themeChoice);
    });
  }
  applyTheme(getThemeChoice());
  if (MEDIA && MEDIA.addEventListener) {
    MEDIA.addEventListener('change', () => {
      // 只在未显式选择时跟随系统（显式选择优先级更高）
      if (getThemeChoice() === '') applyTheme('');
    });
  }
}
