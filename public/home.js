import { $, api, toast, saveHost, savePlayer, lastName, loadMode } from '/common.js';

loadMode();

// The host is seated automatically (last name used on this device, else "Host") and lands in the room.
function enter({ code, hostToken, playerId, playerToken, name }) {
  saveHost(code, hostToken);
  savePlayer(code, { playerId, playerToken, name });
  location.href = `/r/${code}`;
}

$('#play-sample').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Lighting the candles...';
  try {
    enter(await api('/api/rooms/sample', { method: 'POST', body: { hostName: lastName() || 'Host' } }));
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.innerHTML = '&#9670; Play the sample mystery';
  }
});

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const btn = $('#create-btn');
  btn.disabled = true; btn.textContent = 'Opening the parlor...';
  try {
    enter(await api('/api/rooms', {
      method: 'POST',
      body: { title: f.get('title'), premise: f.get('premise'), story: f.get('story'), secret: f.get('secret'), hostName: lastName() || 'Host' },
    }));
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.textContent = 'Open the parlor';
  }
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) return toast('Enter the room code from your host.', 'error');
  location.href = `/r/${code}`;
});
