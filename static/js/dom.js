const views = {
  database: document.getElementById('view-database'),
  segments: document.getElementById('view-segments'),
  lookup: document.getElementById('view-lookup'),
  ai: document.getElementById('view-ai'),
  chat: document.getElementById('view-chat'),
};

const tabs = Array.from(document.querySelectorAll('.bottom-nav .tab'));

export const els = {
  txtList: document.getElementById('txtList'),
  excelFiles: document.getElementById('excelFiles'),
  lookupBody: document.getElementById('lookupBody'),
  aiList: document.getElementById('aiList'),
  aiSend: document.getElementById('aiSend'),
  aiInput: document.getElementById('aiInput'),
  aiKey: document.getElementById('aiKey'),
  aiModel: document.getElementById('aiModel'),
  aiSystem: document.getElementById('aiSystem'),
  aiKeyToggle: document.getElementById('aiKeyToggle'),
  aiComposerForm: document.getElementById('aiComposerForm'),
  content: document.getElementById('content'),
  copyAll: document.getElementById('copyAllBtn'),
  // chat room elements can be queried by id directly when needed
};

let toastTimer = null;

export function showToast(text, timeout = 1500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  container.textContent = String(text || '');
  container.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => container.classList.remove('show'), timeout);
}

export function setActiveView(name) {
  Object.entries(views).forEach(([key, node]) => {
    if (!node) return;
    const isActive = key === name;
    node.classList.toggle('active', isActive);
  });
  tabs.forEach((tab) => {
    const target = tab.getAttribute('data-view');
    tab.setAttribute('aria-selected', String(target === name));
  });
  window.__currentView = name;
}

export function initNavigation(defaultView = 'segments') {
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.getAttribute('data-view');
      if (name) setActiveView(name);
    });
  });
  setActiveView(defaultView);
}
