# Scheduling

A tunnel usually has a *context*. A work database is only wanted during work hours,
and only on a trusted network; a home-lab tunnel is pointless when you're away from
home. **Scheduling** lets a tunnel — or a whole group — **arm and disarm itself** on
a **time window** and/or a **network condition**, so Port Hippo follows your day
instead of waiting on your hand toggles.

All the detection is **local and read-only**. No network name, Wi-Fi SSID, or probe
result ever leaves your machine or appears in a log or diagnostics report.

## Turning it on

Scheduling is **off by default**. Enable it globally in **Settings → Behaviour →
Arm tunnels on a schedule**, then give individual tunnels (or groups) a schedule in
their editor's **Schedule** section. Nothing gains a schedule implicitly: a tunnel is
only managed once you add a condition to it.

A scheduled tunnel is badged in the list and the detail view with a small clock and
its next transition — for example **9:00** when it will arm at 9 am, so you can see
at a glance what the schedule is about to do.

## Time windows

Turn on **Only arm during certain hours** and pick:

- the **days** of the week the window applies to, and
- a **From** and **To** time, in your machine's local time.

The tunnel arms at the start of the window and disarms at the end. A window can
**wrap past midnight** — set *From* `22:00` and *To* `06:00` on Friday and the tunnel
stays armed from Friday night into Saturday morning.

## Network conditions

Turn on **Only arm on certain networks** to gate a tunnel on where you are:

- **Wi-Fi networks** — an allow-list of SSIDs. The tunnel arms only while you're
  connected to one of them. Click **Use current network** to add the network you're
  on right now.
- **Reachable host** — a `host:port` the tunnel probes with a plain TCP connection
  (for example an office server). The tunnel arms only while that address answers.

> **Fail-safe.** When Port Hippo can't read the current Wi-Fi network (some platforms
> don't expose it), an SSID condition is treated as *not met* — an ambiguous network
> never arms a tunnel it shouldn't. The reachability probe only ever opens a socket;
> it never runs a command anywhere.

## Combining conditions

The two conditions are **ANDed**: when both are set, a tunnel is wanted only when the
time window **and** the network condition hold at the same time. Either condition on
its own is enough to schedule a tunnel; leaving both off means the tunnel isn't
scheduled.

## Group schedules

A **group** can carry a schedule in its editor, and every member **inherits** it —
one rule governs the whole set. A member that sets *its own* schedule overrides the
group's for that tunnel. See [Defining Tunnels](defining-tunnels.md) for groups.

## Manual override

A schedule never fights you. If you **arm or disarm a scheduled tunnel by hand** —
from its row, the tray, or a group action — Port Hippo respects that until the next
**boundary** (the next window edge, or the next network change), then the rule
resumes. While you're in control the tunnel's badge says so.

## How it decides (no busy-polling)

The scheduler is **edge-triggered**: it re-evaluates on the next window boundary, when
your laptop wakes from sleep, and on a slow safety re-check — not on a per-second
tick. A reachability probe runs only when a rule actually needs one. Times use your
machine's local clock via the OS, so a schedule follows you across time-zone changes.
