import { els, showToast } from './dom.js';
import { escapeHtml, escapeRegExp } from './utils.js';

function highlightText(text, word) {
  if (!text) return '';
  const regex = new RegExp(`(\\b${escapeRegExp(word)}\\b)`, 'ig');
  return escapeHtml(text).replace(regex, '<span class="highlight">$1</span>');
}

export function renderLookupCard(word, sheet, rowIndex, rowData) {
  if (!els.lookupBody) return;
  const container = document.createElement('div');
  container.className = 'lookup-card';
  container.innerHTML = `
    <div class="lookup-title">${escapeHtml(word)}</div>
    <div class="lookup-meta"></div>
    <div class="lookup-kv">
      <div class="k">单词</div>
      <div>${highlightText(rowData?.['1'] || '', word)}<div class="small mono">(${escapeHtml(word)})</div></div>
      <div class="k">音标</div>
      <div>${escapeHtml(rowData?.['2'] || '')}</div>
      <div class="k">释义</div>
      <div>${highlightText(rowData?.['3'] || '', word)}</div>
    </div>
  `;
  els.lookupBody.innerHTML = '';
  els.lookupBody.appendChild(container);
  try { els.lookupBody.scrollTop = 0; } catch { /* ignore */ }
}

export function renderLookupNotFound(word) {
  if (!els.lookupBody) {
    showToast(`未查询到：${word}`);
    return;
  }
  const div = document.createElement('div');
  div.className = 'lookup-card';
  div.textContent = `未查询到：${word}`;
  els.lookupBody.innerHTML = '';
  els.lookupBody.appendChild(div);
}

export function renderLookupError(message) {
  if (!els.lookupBody) {
    showToast(String(message || '查询失败'));
    return;
  }
  const div = document.createElement('div');
  div.className = 'lookup-card';
  div.textContent = String(message || '查询失败');
  els.lookupBody.innerHTML = '';
  els.lookupBody.appendChild(div);
}
