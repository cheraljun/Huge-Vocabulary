import { els, showToast, setActiveView } from './dom.js';
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

async function lookupWord(word) {
  try {
    const data = await fetchJSON(`/api/excel/search?word=${encodeURIComponent(word)}`);
    if (!data.matches || data.matches.length === 0) {
      renderLookupNotFound(word);
      return;
    }
    const first = data.matches[0];
    try {
      const record = await fetchJSON(`/api/excel/row?sheet=${encodeURIComponent(first.sheet)}&row_index=${encodeURIComponent(first.row_index)}`);
      renderLookupCard(word, first.sheet, first.row_index, record.row);
    } catch (err) {
      renderLookupError(`读取行失败：${err.message}`);
    }
  } catch (err) {
    renderLookupError(`查询失败：${err.message}`);
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
          const confirmed = window.confirm(`您已选择：${baseName}\n学习愉快！`);
          if (confirmed) {
            renderSentenceCenter(text);
            if (activeTile && activeTile !== tile) {
              activeTile.classList.remove('active');
            }
            tile.classList.add('active');
            activeTile = tile;
            setActiveView('segments');
          }
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
