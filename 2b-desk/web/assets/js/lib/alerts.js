// Sounds (generated, no audio files), desktop notifications and the tab title.
let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem('desk.muted') === '1';
} catch {
  /* ignore */
}

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try {
    localStorage.setItem('desk.muted', muted ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Browsers only allow sound after the person has clicked something.
export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq, at, dur, type = 'sine', gain = 0.07) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

export function chime(kind) {
  if (muted || !ctx) return;
  try {
    const t = ctx.currentTime + 0.01;
    if (kind === 'new') {
      tone(660, t, 0.14);
      tone(990, t + 0.13, 0.22);
    } else if (kind === 'reminder') {
      tone(880, t, 0.12);
      tone(880, t + 0.22, 0.12);
    } else if (kind === 'transfer') {
      tone(523, t, 0.11);
      tone(659, t + 0.11, 0.11);
      tone(784, t + 0.22, 0.2);
    } else if (kind === 'late') {
      tone(392, t, 0.22, 'triangle', 0.09);
      tone(311, t + 0.26, 0.32, 'triangle', 0.09);
    } else {
      tone(740, t, 0.12);
    }
  } catch {
    /* audio is a nicety */
  }
}

export const canNotify = () => 'Notification' in window;
export const notifyPermission = () => (canNotify() ? Notification.permission : 'unsupported');
export async function askNotify() {
  if (!canNotify()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

// Only when the tab is in the background — otherwise the in-page toast is enough.
export function desktop(title, body, onClick) {
  if (!canNotify() || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, { body, icon: 'assets/img/icon.svg', silent: true });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

const baseTitle = document.title;
export function setTitleCount(n) {
  document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
}
