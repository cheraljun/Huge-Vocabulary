import { els, showToast, setActiveView } from './dom.js';
import { focusChat } from './ai_chat.js';
import { fetchJSON } from './utils.js';
import { renderLookupCard, renderLookupError, renderLookupNotFound } from './lookup.js';

function parseMarkedTokens(text) {
  const parts = [];
  let lastIndex = 0;
  const regex = /\[\[([A-Za-z][A-Za-z\-']{0,63})\]\]/g;
  let match;
  while ((match = regex.exec(text))) {
    const start = match.index;
    const end = regex.lastIndex;
    if (start > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    const word = (match[1] || '').trim();
    parts.push({ type: 'token', word });
    lastIndex = end;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts;
}

export function renderSentenceCenter(text) {
  if (!els.content) return;
  window.__currentTxtFull = String(text || '');
  if (!window.__currentTxtName) {
    // 保底：若未在列表点击时设置名称，则使用默认
    window.__currentTxtName = '全文';
  }
  const parts = parseMarkedTokens(text || '');
  const container = document.createElement('div');
  container.className = 'sentence';
  for (const part of parts) {
    if (part.type === 'text') {
      container.appendChild(renderTextWithClickableWords(part.value));
    } else if (part.type === 'token') {
      const span = document.createElement('span');
      span.className = 'token';
      span.textContent = part.word;
      span.dataset.word = part.word;
      span.title = `查询：${part.word}`;
      span.addEventListener('click', () => onTokenClick(part.word));
      container.appendChild(span);
    }
  }
  els.content.innerHTML = '';
  els.content.appendChild(container);
}

function onTokenClick(word) {
  setActiveView('lookup');
  lookupWord(word);
}

function renderTextWithClickableWords(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text || '');
  const regex = /[A-Za-z][A-Za-z\-']{0,63}/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(source))) {
    const start = match.index;
    const end = regex.lastIndex;
    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(source.slice(lastIndex, start)));
    }
    const word = match[0];
    const span = document.createElement('span');
    span.className = 'word-click';
    span.textContent = word;
    span.dataset.word = word;
    span.title = `查询：${word}`;
    span.addEventListener('click', () => onTokenClick(word));
    fragment.appendChild(span);
    lastIndex = end;
  }
  if (lastIndex < source.length) fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
  return fragment;
}

function fallbackToAI(word) {
  try {
    focusChat();
    if (els.aiInput) {
      els.aiInput.value = String(word || '');
    }
    if (els.aiComposerForm && typeof els.aiComposerForm.requestSubmit === 'function') {
      els.aiComposerForm.requestSubmit();
    } else if (els.aiComposerForm) {
      const evt = new Event('submit', { bubbles: true, cancelable: true });
      els.aiComposerForm.dispatchEvent(evt);
    }
  } catch (e) {
    // 最坏情况下给出提示
    showToast('已为你跳转到智能体');
    setActiveView('ai');
  }
}

async function lookupWord(word) {
  try {
    const data = await fetchJSON(`/api/lookup?word=${encodeURIComponent(word)}`);
    if (!data || !data.row) {
      // 未命中：自动跳转到智能体并发送该词
      fallbackToAI(word);
      return;
    }
    renderLookupCard(word, '', 0, data.row);
  } catch (err) {
    // 404 或其他错误：同样走智能体兜底
    fallbackToAI(word);
  }
}

export async function loadTxtList() {
  if (!els.txtList) return;
  try {
    const data = await fetchJSON('/api/txt/list');
    const list = data.files || [];
    els.txtList.innerHTML = '';
    let activeTile = null;
    list.forEach((name) => {
      const base = String(name).replace(/\.[^.]+$/, '');
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.textContent = base;
      tile.dataset.name = name;
      tile.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          const data = await fetchJSON(`/api/txt/content?name=${encodeURIComponent(name)}`);
          const text = (data.content || '').trim();
          const baseName = String(name).replace(/\.[^.]+$/, '');
          // 移除确认窗口，改用Toast通知
          renderSentenceCenter(text);
          window.__currentTxtName = baseName;
          if (activeTile && activeTile !== tile) {
            activeTile.classList.remove('active');
          }
          tile.classList.add('active');
          activeTile = tile;
          setActiveView('segments');
          showToast(`已加载：${baseName}，学习愉快！`, 2000);
        } catch {
          showToast('加载失败');
        }
      });
      els.txtList.appendChild(tile);
    });
    els.txtList.classList.add('tile-grid');
  } catch (error) {
    showToast('读取分段列表失败');
  }
}
