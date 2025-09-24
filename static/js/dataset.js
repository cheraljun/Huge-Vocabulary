import { els } from './dom.js';
import { fetchJSON, formatSize } from './utils.js';

let excelRows = new Map();

export async function refreshExcelFiles() {
  if (!els.excelFiles) return;
  const data = await fetchJSON('/api/excel/files');
  const files = data.files || [];
  els.excelFiles.innerHTML = '';
  excelRows = new Map();
  files.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'excel-file';

    const info = document.createElement('div');
    const nameNode = document.createElement('div');
    nameNode.textContent = file.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${formatSize(file.size)} · ${file.mtime}`;
    info.appendChild(nameNode);
    info.appendChild(meta);

    const status = document.createElement('button');
    status.textContent = '未载入';
    status.disabled = true;

    row.appendChild(info);
    row.appendChild(status);
    els.excelFiles.appendChild(row);
    excelRows.set(file.name, status);
  });
}

export async function refreshExcelStatus() {
  if (!els.excelFiles) return;
  try {
    const data = await fetchJSON('/api/excel/status');
    const isLoaded = Boolean(data.loaded);
    const label = isLoaded ? '已载入' : '未载入';
    const activeName = data.current_file ? data.current_file.split(/[\\/]/).pop() : null;
    excelRows.forEach((button, name) => {
      button.textContent = label;
      const highlight = isLoaded && activeName && activeName === name;
      button.classList.toggle('active', highlight);
    });
  } catch {
    // ignore errors silently
  }
}
