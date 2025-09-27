import { els, showToast, setActiveView } from './dom.js';
import { fetchJSON } from './utils.js';

let sending = false;
let pendingBubble = null;

export function initChat() {
  if (els.aiModel) {
    const models = [
      'tencent/Hunyuan-A13B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'Qwen/Qwen3-235B-A22B-Thinking-2507',
      'Qwen/Qwen2.5-7B-Instruct',
      'zai-org/GLM-4.5',
      'Qwen/QwQ-32B',
    ];
    els.aiModel.innerHTML = '';
    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      els.aiModel.appendChild(option);
    });
  }

  if (els.aiSystem && !els.aiSystem.value) {
    els.aiSystem.value = '下面你来充当翻译家，你的目标是把任何语言翻译成中文，由于我的目的是学习英语，你需要以原文为依据进行翻译，然后输出翻译的结果，保证用户对照着中文看原文能够完全理解';
  }

  if (els.aiKeyToggle && els.aiKey) {
    els.aiKeyToggle.addEventListener('click', () => {
      const isPassword = els.aiKey.getAttribute('type') === 'password';
      els.aiKey.setAttribute('type', isPassword ? 'text' : 'password');
      els.aiKeyToggle.textContent = isPassword ? '隐藏' : '显示';
      els.aiKey.focus({ preventScroll: true });
    });
  }

  if (els.aiKey && !els.aiKey.value) {
    els.aiKey.value = 'sk-maadyokebopfltzxonapnlitaucqxbpwvzkvpwizihvnhsmc';
  }

  if (els.aiComposerForm && els.aiInput) {
    els.aiComposerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });
    els.aiInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        sendMessage();
      }
    });
    setupAutoGrow();
  }
}

async function sendMessage() {
  if (sending) return;
  const content = (els.aiInput?.value || '').trim();
  const apiKey = (els.aiKey?.value || '').trim();
  const model = (els.aiModel?.value || '').trim() || 'Qwen/QwQ-32B';
  const system = (els.aiSystem?.value || '').trim();
  if (!content) return;
  appendUserBubble(content);
  if (els.aiInput) els.aiInput.value = '';
  resetInputHeight();
  setSending(true);
  showPending();
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, api_key: apiKey, model, system }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    appendBotBubble(data?.message || '[空回复]');
  } catch (error) {
    appendBotBubble(`请求失败：${error.message}`);
  } finally {
    setSending(false);
  }
}

function appendUserBubble(text) {
  if (!els.aiList) return;
  const bubble = document.createElement('div');
  bubble.className = 'bubble user';
  bubble.textContent = text;
  els.aiList.appendChild(bubble);
  scrollToBottom();
}

function appendBotBubble(text) {
  if (!els.aiList) return;
  if (pendingBubble) {
    pendingBubble.textContent = text;
    pendingBubble.classList.remove('pending');
    pendingBubble = null;
  } else {
    const bubble = document.createElement('div');
    bubble.className = 'bubble bot';
    bubble.textContent = text;
    els.aiList.appendChild(bubble);
  }
  scrollToBottom();
}

function showPending() {
  if (!els.aiList) return;
  const bubble = document.createElement('div');
  bubble.className = 'bubble bot pending';
  bubble.textContent = '思考中...';
  els.aiList.appendChild(bubble);
  pendingBubble = bubble;
  scrollToBottom();
}

function setSending(flag) {
  sending = Boolean(flag);
  if (els.aiSend) els.aiSend.disabled = sending;
  if (els.aiInput) els.aiInput.disabled = sending;
}

function scrollToBottom() {
  if (!els.aiList) return;
  els.aiList.scrollTop = els.aiList.scrollHeight;
}

function setupAutoGrow() {
  if (!els.aiInput) return;
  const baseHeight = Math.max(els.aiInput.scrollHeight, 44);
  els.aiInput.dataset.baseHeight = String(baseHeight);
  els.aiInput.style.overflowY = 'hidden';
  adjustInputHeight();
  els.aiInput.addEventListener('input', adjustInputHeight);
  els.aiInput.addEventListener('focus', adjustInputHeight);
}

function adjustInputHeight() {
  if (!els.aiInput) return;
  els.aiInput.style.height = 'auto';
  const maxHeight = 160;
  const next = Math.min(Math.max(els.aiInput.scrollHeight, 44), maxHeight);
  els.aiInput.style.height = `${next}px`;
  els.aiInput.style.overflowY = next >= maxHeight ? 'auto' : 'hidden';
}

function resetInputHeight() {
  if (!els.aiInput) return;
  const base = Number(els.aiInput.dataset.baseHeight || 44);
  els.aiInput.style.height = `${base}px`;
  adjustInputHeight();
}

export function focusChat() {
  setActiveView('ai');
  els.aiInput?.focus();
}
