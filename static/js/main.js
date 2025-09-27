import { els, initNavigation, showToast, setActiveView } from './dom.js';
import { loadTxtList } from './text.js';
import { refreshExcelFiles, refreshExcelStatus } from './dataset.js';
import { initChat } from './ai_chat.js';

function initCopyButton() {
  if (!els.copyAll) return;
  els.copyAll.addEventListener('click', async () => {
    const text = String(window.__currentTxtFull || '');
    const name = String(window.__currentTxtName || '全文');
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('已开始下载');
    } catch {
      showToast('下载失败');
    }
  });
}

function initGuide() {
  const guide = document.getElementById('guide');
  const closeBtn = document.getElementById('guideClose');
  if (!guide || !closeBtn) return;
  closeBtn.addEventListener('click', () => {
    guide.setAttribute('hidden', 'hidden');
    setActiveView('database');
  });
}

async function init() {
  initNavigation('database');
  initCopyButton();
  initChat();
  initGuide();

  // 可选：如果URL带有#chat则直接进入聊天室
  if (location.hash === '#chat') {
    setActiveView('chat');
  }

  await Promise.allSettled([
    loadTxtList(),
    refreshExcelFiles().then(refreshExcelStatus),
  ]);
}

init().catch((error) => {
  console.error(error);
  showToast('初始化失败');
});
