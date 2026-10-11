// Collects what a transaction changed, so the realtime hub can tell the right
// people only after the change is safely committed.
export class Effects {
  constructor() {
    this.convIds = new Set();
    this.lostBy = new Map(); // conversation id -> user ids who no longer hold it
    this.messages = [];
    this.notes = [];
    this.toasts = [];
    this.users = new Set(); // users whose own status changed
    this.team = false;
    this.endSessions = []; // { sessionId, reason }
  }

  conv(id, ...lostBy) {
    this.convIds.add(Number(id));
    for (const u of lostBy) {
      if (u == null) continue;
      if (!this.lostBy.has(Number(id))) this.lostBy.set(Number(id), new Set());
      this.lostBy.get(Number(id)).add(Number(u));
    }
  }

  message(row) {
    this.messages.push(row);
  }

  note(row) {
    this.notes.push(row);
  }

  toast(userId, payload) {
    if (userId != null) this.toasts.push({ userId: Number(userId), payload });
  }

  supervisors(payload) {
    this.toasts.push({ role: 'supervisor', payload });
  }

  user(id) {
    this.users.add(Number(id));
    this.team = true;
  }

  teamChanged() {
    this.team = true;
  }

  endSession(sessionId, reason) {
    this.endSessions.push({ sessionId, reason });
  }

  get empty() {
    return (
      !this.convIds.size && !this.messages.length && !this.notes.length && !this.toasts.length &&
      !this.users.size && !this.team && !this.endSessions.length
    );
  }
}
