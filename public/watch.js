const params = new URLSearchParams(location.search);
const token = params.get('v');

const emptyState = document.querySelector('#emptyState');
const playerWrap = document.querySelector('#playerWrap');
const errorState = document.querySelector('#errorState');
const videoTitle = document.querySelector('#videoTitle');
const drivePlayer = document.querySelector('#drivePlayer');
const errorText = document.querySelector('#errorText');

function showError(message) {
  emptyState.classList.add('hidden');
  playerWrap.classList.add('hidden');
  errorState.classList.remove('hidden');
  errorText.textContent = message;
  document.title = 'Video unavailable · Private Stream';
}

async function start() {
  if (!token) {
    showError('No watch token was supplied. Create a link from the admin page.');
    return;
  }

  try {
    const response = await fetch(`/api/video?v=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load this video.');

    videoTitle.textContent = data.title;
    document.title = `${data.title} · Private Stream`;
    drivePlayer.src = data.previewUrl;
    emptyState.classList.add('hidden');
    playerWrap.classList.remove('hidden');
  } catch (err) {
    showError(err.message || 'Could not load this video.');
  }
}

start();
