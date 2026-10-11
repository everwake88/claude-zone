# How 2B Desk works — for agents and supervisors

## A shift, from an agent's side

1. **Sign in** with your username and password. That is your **check-in**; the
   time is recorded. You start as **Not ready**.
2. Press **Ready**. Chats start arriving by themselves, with a sound and a
   notice. The timer next to the button shows how long you have been Ready.
3. Your queue shows, for every chat: where it came from (**WA**, **FB**, **IG**),
   what it is about (**Sales**, **Complaint**, **Follow-up**, **Inquiry**), how
   long it has been with you, and how much time is left before the customer
   has waited too long. The most urgent chat is always on top.
4. Open a chat: the AI's hand-off note is at the top, then the whole
   conversation — the customer, the AI (marked *AI agent*) and your team.
   Type, press **Enter**. ✓ means it reached the customer.
5. Too busy? **Transfer** → pick a teammate (you see how full everyone is) →
   add a note → **Send request**. They can **Accept** or answer **No
   availability**. Until they accept, the chat stays with you.
6. Done? **Resolve**. If the customer writes again later, the AI answers them.
7. Break: press **Not ready**. You keep your chats and can still answer them,
   but you receive nothing new.
8. End of shift: avatar → **Check out & sign out**. Any chats you still have
   go back to the team. That is your **check-out**.

## Who gets which chat

- Only people who are **signed in, connected and Ready** receive chats.
- A new chat goes to the Ready person with the **fewest chats**. If several
  have the same number, it goes to the one who has waited longest since their
  last chat.
- **Nobody ever holds more than 25** (an admin can lower it per person).
- When everyone is full, chats wait in the **team queue** and go out — oldest
  first — the moment anyone has room or presses Ready.

So with 100 chats: 4 Ready agents get 25 each; 5 Ready agents get 20 each;
3 Ready agents get 25 each and 25 chats wait for room.

## The 15-minute rule

The clock starts when a customer writes and stops when someone replies.

| Minute | What happens |
|---|---|
| 0 | The chat goes to the least busy Ready agent. |
| 5 and 8 | Reminder to that agent: notice, sound, desktop alert. |
| 10 | No reply → the chat **moves** to the least busy Ready teammate who has not had it yet. It arrives marked urgent. |
| 11, 12, 13… | Still no reply → it keeps moving, one minute with each person. |
| 15 | The chat is **LATE**. It turns red, supervisors are alerted, and it keeps moving until somebody answers. The red badge counts **how late**. |

- Each new customer message after a reply starts a fresh clock — and the agent
  who has the chat gets a fresh 10 minutes.
- A reply counts from the moment you press Send. If you press Send at 9:58,
  the chat cannot be taken from you while the message is on its way.
- A chat you accepted from a teammate keeps the original deadline.
- If nobody else is free when time is up, the chat stays where it is (still
  counting) and moves as soon as someone has room.

All of these numbers are in **Settings** (admins).

## Connection and presence

- The dashboard checks in every 20 seconds. **No signal for 90 seconds** (laptop
  closed, Wi-Fi gone) → you are **offline**: customers who are waiting for you
  are moved to teammates straight away; chats you already answered stay.
- When you come back you are **Not ready** — press Ready again.
- **Offline for 30 minutes** = automatically **checked out**: all your chats go
  back to the team and you sign in again next time.
- Signing in on a second computer signs the first one out.

## For supervisors

**Live** — the whole floor: who is Ready / Not ready / offline and for how
long, each person's load, who has customers waiting, every open chat ordered
by urgency. Click a person to see only their chats. The coffee-cup button pauses
someone (sets them Not ready) without taking their chats.

**Open any chat** from Live: you can read it, reply (that stops the clock too),
**Reassign** it to someone, send it back to the team queue, or **Track** it.

**Track** shows a chat's whole journey: every person who held it, from when to
when, how many chats they had, how many replies they sent to other customers
meanwhile, and how long they were typing. Each person who let it time out is
marked:

| Mark | Meaning |
|---|---|
| **Busy** | Replying to other customers (at least one reply every two minutes) or typing at least a quarter of the time. |
| **Idle** | No replies anywhere and almost no typing (under 5% of the time). |
| **Some activity** | In between. |
| **Replied** | Answered the customer. |
| **Offline** | Disconnected for most of that time. |

The thresholds are in Settings → *Busy or idle*.

## The day report (Reports)

Pick any day; today refreshes every minute. **Export agents (CSV)** gives the
team table as a spreadsheet.

| Number | Definition |
|---|---|
| **Chats handled** | Chats where somebody from the team sent at least one reply that day. |
| **New chats from the AI** | Chats the AI handed to the team that day; next to it, how many customers wrote to 2B in total that day. |
| **Resolved** | Chats closed with **Resolve** that day. |
| **First reply** | From the hand-off to the team's first reply. Average and median. |
| **Replies within 15 min** | Of all the times a customer waited for the team, how many got a reply in time. |
| **Late replies** | Waits that ended after 15 minutes. |
| **By category / By source** | The chats handed to the team, by what they were about and where they came from (WhatsApp, Messenger, Instagram). |
| **Through the day** | New chats and replies, hour by hour. |

The **team table**, per person:

| Column | Definition |
|---|---|
| In / out | First check-in and last check-out of the day (“now” if still signed in). |
| Ready / Not ready | Total time in each status that day. |
| Day | The day as a bar: green = Ready, amber = Not ready, grey = offline. |
| Chats | Chats they replied to that day. |
| Replies | Messages they sent. |
| Avg reply | Average time customers waited before their reply. |
| Late | Their replies that came after 15 minutes. |
| Moved away | Chats taken from them for not replying in time — and how many of those times they were idle or busy. |
| Typing | Time spent typing in the reply box, and its share of their Ready time. |

**Late chats** lists every late wait of the day with **Track** next to it.

## What typing activity is — and isn't

The desk counts keys pressed in the reply box and how long someone typed
continuously. It does not record what was typed outside messages that were
sent, and nothing outside the desk. Typing time is a signal, not a verdict:
read it next to chats, replies and reply times. Someone pressing keys to look
busy shows up as a lot of typing and few replies.
