const form = document.querySelector('#createForm');
const adminPassword = document.querySelector('#adminPassword');
const titleInput = document.querySelector('#title');
const driveUrlInput = document.querySelector('#driveUrl');
const expiryDays = document.querySelector('#expiryDays');
const createButton = document.querySelector('#createButton');
const formMessage = document.querySelector('#formMessage');
const resultCard = document.querySelector('#resultCard');
const resultTitle = document.querySelector('#resultTitle');
const watchUrlInput = document.querySelector('#watchUrl');
const copyButton = document.querySelector('#copyButton');
const openButton = document.querySelector('#openButton');
const historyNode = document.querySelector('#history');
const historyEmpty = document.querySelector('#historyEmpty');
const clearHistory = document.querySelector('#clearHistory');

const HISTORY_KEY = 'private-stream:history:v1';

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20)));
}

function addHistory(item) {
  const items = loadHistory().filter((x) => x.url !== item.url);
  items.unshift(item);
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  historyNode.replaceChildren();
  historyEmpty.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'history-item';

    const meta = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title || 'Private video';
    const time = document.createElement('span');
    time.textContent = new Date(item.createdAt).toLocaleString();
    meta.append(title, time);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await copyText(item.url);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });

    const open = document.createElement('a');
    open.className = 'text-button';
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';

    actions.append(copy, open);
    row.append(meta, actions);
    historyNode.append(row);
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temp = document.createElement('textarea');
  temp.value = value;
  temp.style.position = 'fixed';
  temp.style.opacity = '0';
  document.body.append(temp);
  temp.select();
  document.execCommand('copy');
  temp.remove();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'form-message';
  createButton.disabled = true;
  createButton.textContent = 'Creating…';

  try {
    const response = await fetch('/api/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword.value
      },
      body: JSON.stringify({
        title: titleInput.value,
        driveUrl: driveUrlInput.value,
        expiryDays: Number(expiryDays.value)
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not create the watch link.');

    resultTitle.textContent = data.title;
    watchUrlInput.value = data.watchUrl;
    openButton.href = data.watchUrl;
    resultCard.classList.remove('hidden');
    formMessage.textContent = 'Link created. Your admin password was not saved.';
    formMessage.classList.add('success');

    addHistory({ title: data.title, url: data.watchUrl, createdAt: Date.now() });
    watchUrlInput.focus();
    watchUrlInput.select();
  } catch (err) {
    formMessage.textContent = err.message || 'Something went wrong.';
    formMessage.classList.add('error');
  } finally {
    adminPassword.value = '';
    createButton.disabled = false;
    createButton.textContent = 'Create private watch link';
  }
});

copyButton.addEventListener('click', async () => {
  await copyText(watchUrlInput.value);
  copyButton.textContent = 'Copied';
  setTimeout(() => { copyButton.textContent = 'Copy'; }, 1200);
});

clearHistory.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

renderHistory();
