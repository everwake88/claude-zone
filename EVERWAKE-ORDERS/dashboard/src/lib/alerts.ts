'use client';
// A two-tone chime for a new order — generated, so there is no file to host.
let ctx: AudioContext | null = null;
export function chime() {
  try {
    ctx = ctx || new AudioContext();
    const now = ctx.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.35, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.5);
      o.connect(g).connect(ctx!.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.55);
    });
  } catch { /* the browser blocks audio until the page is clicked once */ }
}

export function notify(title: string, body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/icon.svg' }); } catch { /* some browsers only allow it from a service worker */ }
  }
}

export async function askNotificationPermission() {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}
