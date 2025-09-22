const txtListEl = document.getElementById('txtList');
const excelFilesEl = document.getElementById('excelFiles');
const chatListEl = document.getElementById('chatList');
const contentEl = document.getElementById('content');
// ensure segments list uses tile grid layout
if (txtListEl) { txtListEl.classList.add('tile-grid'); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseSlashedTokens(text) {
  // Find /word/ patterns; keep original text flow
  const parts = [];
  let lastIndex = 0;
  const regex = /\/([^\/\n\r]+)\//g; // /word/
  let m;
  while ((m = regex.exec(text))) {
    const start = m.index;
    const end = regex.lastIndex;
    if (start > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, start) });
    const raw = m[0];
    const word = (m[1] || '').trim();
    parts.push({ type: 'token', value: raw, word });
    lastIndex = end;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts;
}

function scrollChatToBottom(smooth = true) {
  if (!chatListEl) return;
  try {
    chatListEl.scrollTo({ top: chatListEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  } catch (e) {
    // Fallback
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }
}

function appendBubble(el) {
  chatListEl.appendChild(el);
  // smooth scroll to bottom
  scrollChatToBottom(true);
}

function createBubble(type) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${type}`;
  return bubble;
}

// Render sentence into center column (not chat)
function renderSentenceCenter(text) {
  const parts = parseSlashedTokens(text || '');
  const container = document.createElement('div');
  container.className = 'sentence';
  for (const p of parts) {
    if (p.type === 'text') {
      container.appendChild(document.createTextNode(p.value));
    } else if (p.type === 'token') {
      const span = document.createElement('span');
      span.className = 'token';
      span.textContent = p.word; // 显示词本身，不显示斜杠
      span.dataset.word = p.word;
      span.title = `查询：${p.word}`;
      span.addEventListener('click', () => onTokenClick(p.word));
      container.appendChild(span);
    }
  }
  contentEl.innerHTML = '';
  contentEl.appendChild(container);
}

async function onTokenClick(word) {
  // user bubble on the right chat
  const user = createBubble('user');
  user.textContent = word;
  appendBubble(user);

  // lookup
  try {
    const data = await fetchJSON(`/api/excel/search?word=${encodeURIComponent(word)}`);
    if (!data.matches || data.matches.length === 0) {
      appendInfoBubble('未在 Excel 中找到该词汇。');
      return;
    }
    const first = data.matches[0];
    try {
      const r = await fetchJSON(`/api/excel/row?sheet=${encodeURIComponent(first.sheet)}&row_index=${encodeURIComponent(first.row_index)}`);
      const card = renderMatchCard(word, first.sheet, first.row_index, r.row);
      const bot = createBubble('bot');
      bot.appendChild(card);
      appendBubble(bot);
    } catch (e) {
      appendInfoBubble(`读取行失败：${e.message}`);
    }
  } catch (e) {
    appendInfoBubble(`查询失败：${e.message}`);
  }
}

function renderMatchCard(word, sheet, rowIndex, rowData) {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.style.marginBottom = '8px';
  header.innerHTML = `<strong>工作表</strong>：${sheet} &nbsp; <span class="k">行</span>：${rowIndex}`;
  card.appendChild(header);

  const row = rowData || {};
  // Heuristic: 0=id, 1=单词, 2=音标, 3=释义
  const wordText = row['1'] || '';
  const phonetic = row['2'] || '';
  const meaning = row['3'] || '';

  const kv = document.createElement('div');
  kv.className = 'kv';
  kv.innerHTML = `
    <div class="k">单词</div><div>${highlightText(wordText, word)}<div class="small mono">(${escapeHtml(word)})</div></div>
    <div class="k">音标</div><div>${escapeHtml(phonetic)}</div>
    <div class="k">释义</div><div>${highlightText(meaning, word)}</div>
  `;
  card.appendChild(kv);
  return card;
}

function appendInfoBubble(text) {
  const bot = createBubble('bot');
  bot.textContent = text;
  appendBubble(bot);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightText(text, word) {
  if (!text) return '';
  const re = new RegExp(`(\\b${escapeRegExp(word)}\\b)`, 'ig');
  return escapeHtml(text).replace(re, '<span class="highlight">$1</span>');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadTxtList() {
  const data = await fetchJSON('/api/txt/list');
  const list = data.files || [];
  txtListEl.innerHTML = '';
  let activeTile = null;
  for (const name of list) {
    const base = String(name).replace(/\.[^.]+$/, '');
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.textContent = base;
    tile.dataset.name = name;
    tile.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const d = await fetchJSON(`/api/txt/content?name=${encodeURIComponent(name)}`);
        renderSentenceCenter((d.content || '').trim());
        if (activeTile) activeTile.classList.remove('active');
        tile.classList.add('active');
        activeTile = tile;
      } catch (err) {
        // ignore
      }
    });
    txtListEl.appendChild(tile);
  }
}

async function refreshExcelStatus() {
  try {
    const data = await fetchJSON('/api/excel/status');
    const status = data.loaded ? '已加载' : (data.running ? '加载中...' : '未加载');
    for (const row of excelFilesEl.querySelectorAll('.excel-file')) {
      const btn = row.querySelector('button');
      if (btn) btn.textContent = status;
    }
  } catch (e) {
    // ignore
  }
}

async function loadExcel(fileName) {
  for (const row of excelFilesEl.querySelectorAll('.excel-file')) {
    const name = row.querySelector('div:first-child > div:first-child')?.textContent;
    const btn = row.querySelector('button');
    if (btn && name === fileName) btn.textContent = '加载中...';
  }
  await fetch(`/api/excel/load?file=${encodeURIComponent(fileName)}`, { method: 'POST' });
}

async function refreshExcelFiles() {
  const data = await fetchJSON('/api/excel/files');
  const files = data.files || [];
  excelFilesEl.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'excel-file';
    const left = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${formatSize(f.size)} · ${f.mtime}`;
    left.appendChild(nameEl);
    left.appendChild(meta);
    const btn = document.createElement('button');
    btn.textContent = '加载';
    btn.addEventListener('click', () => loadExcel(f.name));
    row.appendChild(left);
    row.appendChild(btn);
    excelFilesEl.appendChild(row);
  }
}

function formatSize(bytes) {
  const units = ['B','KB','MB','GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

(function init() {
  // Greeting in chat
  const sys = createBubble('system');
  sys.textContent = '载入一个分段，点击中间句子中的单词即可在右侧查询';
  appendBubble(sys);

  Promise.all([loadTxtList(), refreshExcelFiles(), refreshExcelStatus()])
    .then(() => {})
    .catch(() => {});
  setInterval(refreshExcelStatus, 600);
})();


