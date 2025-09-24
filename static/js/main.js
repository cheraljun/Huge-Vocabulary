import { els, initNavigation, showToast } from './dom.js';
import { loadTxtList } from './text.js';
import { refreshExcelFiles, refreshExcelStatus } from './dataset.js';
import { initChat } from './chat.js';

function initCopyButton() {
  if (!els.copyAll) return;
  els.copyAll.addEventListener('click', async () => {
    const text = String(window.__currentTxtFull || '');
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制全文');
    } catch {
      showToast('复制失败');
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

  await Promise.allSettled([
    loadTxtList(),
    refreshExcelFiles().then(refreshExcelStatus),
  ]);
}

init().catch((error) => {
  console.error(error);
  showToast('初始化失败');
});
