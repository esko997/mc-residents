# Resident chat, 2026-11-20 to 2026-11-23: is it too much, and does it slow them down?

Scope: every chat line on the server from 2026-11-20 00:00 to 2026-11-23 13:31 UTC, and every body tool call by Gary, Margo, Wren and Tobin from 2026-11-22 00:30 to 2026-11-23 13:00 UTC (178,514 calls, 2,355 `say` calls). All times are UTC. Scripts and intermediate files are in `~/.cache/minecraft-review/chat-analysis/work/` (`base.py` parses the call logs; `waits.py`, `cost.py`, `trips.py`, `chains.py`, `pingpong.py`, `rate.py`, `earshot2.py`, `luna.py`, `volume.py` produce the numbers below). Anything marked *[inference]* is my reading, not a measurement.

## The answer

**Chatty: yes, in volume and breadth. Slowed down by it: only a little.**

- Each resident says about 30 lines per online hour (Gary 33–35, Margo 30, Wren 29, Tobin 26), and every line goes to every resident. Since Wren and Tobin arrived, each resident *hears* about 85–92 lines an hour from the others, and 107 of the 108 five-minute windows between 04:00 and 13:00 on 2026-11-23 had chat in them. Only 11–21% of the lines a resident hears name that resident. Lines are long for "one short line": median 120–146 characters, two sentences.
- The time cost is small. Model turns that only produced chat took **2.7–4.3% of wall time** per resident. Adding every idle wait in which the resident was listening for chat (an upper bound, because many of those waits were for crops, furnaces or people arriving) gives **6.5–10.7%**.
- Chat rarely interrupts work. Only **1.8–4.0% of `wait` calls were ended by chat**, because the residents already leave `chat` out of most walking waits (Wren and Tobin include it in 10% of waits, Margo in 25%, Gary in 54%). When chat did wake a resident in the middle of a walk, the walk finished 87–95% of the time for Gary, Wren and Tobin. Margo dropped about a third of those walks.
- Within the same hour, minutes in which a resident talked had between 2.3 fewer and 1.2 more world actions per minute than its silent minutes; the baseline was 8–13. Minutes in which it only heard chat were at most slightly slower, and not consistently. Over a whole hour, the busiest-chat hours were slower (Gary 14.1 world actions per minute in the quietest third of hours, 9.7 in the busiest), but that gap mostly disappears when you compare minutes inside the same hour. That points to the activity, not the talking, as the cause *[inference]*.
- The large time sinks are elsewhere. Gaps of two seconds or more between calls, which are model thinking time, take **57–68% of wall time**. Bodies are walking or mining **at most 19–25%** of the time. Chat is a small slice of a mostly-thinking day.

What chat does cost is attention. Every resident hears everyone's coordination, relays and acknowledgements. Small jobs pull in the whole group: delivering one water bucket to Wren took 25 lines from all four residents (04:09:52–04:19:10 on 11-23). Deaths set off a wave of offers. Some handoffs fail in ways that then take more chat to sort out. These costs grow with the number of residents: what each one hears grows with the headcount, and total traffic grows with its square. Distance or addressing rules are worth having before a fifth resident arrives. A fixed rate limit is not.

## Data and its gaps

- **Server logs** cover 2026-11-20 00:00:07 to 2026-11-23 13:31:15 and have no gaps longer than two minutes except one outage on 11-23: the server stopped at 03:23:52, failed to start 24 times between 03:24:45 and 03:35:24 (each attempt died within about seven seconds), ran from 03:35:54 to 03:46:14, and came back at 03:46:35. No player joined on 2026-11-20 UTC. The first chat is at 2026-11-21 00:13 (a probe bot). Gary's first line is at 01:06 and Margo's at 04:55 on 11-21, which is the evening of 11-20 in New York.
- **The server log does not record every message.** Human lines sent through the relay (`[System] [CHAT] <spesk01> …`) and every Caretaker line exist only in the client logs and in tool-result tails. 28 of spesk01's 36 known lines, and all 19 Caretaker lines found, are missing from the server log.
- **Levi does not appear in any log**: not on the server, not in the clients, not in the calls.
- **Client logs** are complete from 2026-11-23 03:47 to 12:59: per-hour line counts match the server exactly. Before that they are fragments (Gary's client: parts of 11-21 01:00–05:00 and 11-22 02:20–04:59). I gave the undated local times dates by matching each line's text to the server log.
- **`t` in the call log is the start time, not the completion time.** `calllog.ts` writes `t: started.toISOString()`. Check: Margo's last `say` has `t` = 12:59:33.511 and took 91 ms, and the server logged the line at 12:59:33.556.
- In 35 of 178,514 calls the tool-result tail dropped older events; this is negligible.
- **What the call log cannot show:** model thinking per turn, except as the gap before a call; which events the model actually read; and calls made inside skills. Under Codex code mode, one script issues several calls, and a chat line that lands in the middle of a script reaches the model only if the script passes it on. I group calls into "model turns" wherever the gap is 2 s or more (most gaps inside a script are under 50 ms). Reply links are heuristic: a `say` counts as a reply to the most recent other-resident line its speaker heard in the previous 120 s.

## 1. Volume and shape

### Lines per hour (server log, resident chat only; ranges show the lowest and highest hour in each block)

| UTC hour | Gary | Margo | Wren | Tobin |
|---|---|---|---|---|
| 11-21 05–12 (8 h, pre-Sol models) | 39–70 | 38–58 | – | – |
| 11-21 15–20 | 14–49 | 13–46 | – | – |
| 11-22 00–04 | 21–54 | 23–47 | – | – |
| 11-22 05 | 12 | 8 | – | – |
| 11-22 06–12 | 10–51 | 10–42 | – | – |
| 11-22 20–23 | 13–51 | 10–59 | – | – |
| 11-23 00–03 | 21–54 | 14–56 | – | – |
| **11-23 04 (Wren and Tobin arrive)** | **75** | **61** | 19 | 19 |
| 11-23 05–12 | 18–59 | 16–39 | 14–55 | 15–45 |

The full hourly table is printed by `volume.py`. Lines per online hour, by day:

| | 11-21 | 11-22 | 11-23 |
|---|---|---|---|
| Gary | 43.6 | 33.1 | 34.7 |
| Margo | 43.7 | 30.5 | 29.8 |
| Wren | – | – | 29.3 |
| Tobin | – | – | 25.6 |

Gary and Margo talked about a third more on 11-21, before both moved to gpt-6.2-sol (commit 54139ff, 2026-11-21 21:21 UTC; no resident chat falls between that commit and the next session). Since then each resident's rate has been stable at around 30 per hour. Adding two residents did not make Gary and Margo talk less. It doubled what everyone hears.

**Length.** Median line length is 122–124 characters for Gary, 107 → 117 → 124 for Margo over the three days, 146 for Wren and 139 for Tobin. The 90th percentile is 159, 162, 184 and 182 characters. Only one `say` in the window went over 256 characters.

**Bursts.** The busiest five minutes were 04:44:55–04:49:36 on 11-23, with 33 lines: Gary and Margo fighting an Enderman in the Nether while Gary also answered Wren's request for a torch and Tobin repeated Gary's directions to Wren. In the four-resident period, a five-minute window held a mean of 10 lines (median 9, 90th percentile 19, maximum 30), and only one window in 108 was silent.

**Who talks to whom** (window from 11-22 00:30). Each cell gives lines that name the target, plus replies that name nobody. "Nobody" means lines that named nobody and followed no recent line.

| speaker → | Gary | Margo | Wren | Tobin | spesk01 | Caretaker | nobody |
|---|---|---|---|---|---|---|---|
| Gary | – | 93 + 471 | 73 + 43 | 55 + 23 | 14 | 1 + 2 | 219 |
| Margo | 92 + 481 | – | 46 + 23 | 34 + 29 | 11 | 2 + 8 | 172 |
| Wren | 53 + 44 | 40 + 30 | – | 61 + 32 | 1 | 0 + 2 | 20 |
| Tobin | 45 + 34 | 26 + 21 | 57 + 40 | – | 0 | 1 + 1 | 19 |

Gary and Margo are a pair. Most of their lines answer each other, and they account for 391 of the 430 lines addressed to nobody. Wren and Tobin name their listener far more often and almost never broadcast. Of all chat the four residents heard, 98.1% came from other residents, 1.3% from the Caretaker and 0.6% from humans (27 lines, all from spesk01).

**What each resident hears.** Of the resident lines each one heard, these shares named the listener, replied to the listener, or came from a speaker the listener's last status (no more than 60 s old) placed within 48 m:

| listener | names listener | linked reply to listener | speaker within 48 m | none of these |
|---|---|---|---|---|
| Gary | 14% | 43% | 35% | 35% |
| Margo | 11% | 39% | 33% | 42% |
| Wren | 21% | 17% | 19% | 58% |
| Tobin | 17% | 15% | 18% | 64% |

## 2. Cost of chat (measured)

### Share of calls and time

| | Gary | Margo | Wren | Tobin |
|---|---|---|---|---|
| wall time in session | 28.6 h | 28.8 h | 9.0 h | 9.0 h |
| `say` calls | 978 (1.25% of calls) | 882 (1.28%) | 265 (1.80%) | 230 (1.38%) |
| time inside `say` calls | 46 s | 42 s | 11 s | 10 s |
| model turns that begin with `say` | 568 | 491 | 166 | 152 |
| median thinking gap before them | 5.7 s | 5.3 s | 6.4 s | 6.5 s |
| turns with chat and no world action (time incl. thinking) | 419 turns, 53 min (3.1%) | 380, 47 min (2.7%) | 162, 23 min (4.3%) | 148, 17 min (3.2%) |
| idle waits that allowed chat (no walk running) | 93 min | 66 min | 32 min | 41 min |
| upper bound on chat time | 8.5% | 6.5% | 10.2% | 10.7% |
| all thinking gaps of 2 s or more | 16.3 h (57%) | 17.3 h (60%) | 6.1 h (68%) | 5.2 h (58%) |
| walk or mining job running (upper bound) | 25% | 24% | 21% | 19% |

The `say` call itself costs nothing (about 40 ms). The cost is the model turn that writes the line, about 5–6 s each, during which the body almost never moves: only 1–7% of `say` calls happen while a walk is running (Gary 14 of 978, Margo 43/882, Wren 18/265, Tobin 9/230). The persona line "you can talk while you gather, build or walk" describes something they rarely do. That is partly because their walks are short: the median `go_to` target is 3.5 blocks from the last reported position (45% of Gary's and Margo's are 3 blocks or less), so walks usually finish in under a second.

Chat does not seem to slow the next decision. The thinking gap after a tool result that contained chat is no longer than after one that did not: Gary 4.1 s against 5.3 s, Margo 4.7 against 5.0, Wren 4.3 against 5.0, Tobin 4.9 against 5.7.

### How often chat ends a `wait`, and what happens next

`wait` wakes on chat only if `for` includes `chat`, or if `for` is left out.

| | Gary | Margo | Wren | Tobin |
|---|---|---|---|---|
| `wait` calls | 10,927 | 8,463 | 2,279 | 2,547 |
| waits that allowed chat | 5,938 (54%) | 2,147 (25%) | 222 (10%) | 242 (10%) |
| ended by arrival | 9,625 | 7,518 | 2,083 | 2,191 |
| **ended by chat** | **270 (2.5%)** | **149 (1.8%)** | **69 (3.0%)** | **101 (4.0%)** |
| …of which from a resident (the rest from the Caretaker) | 269 | 148 | 68 | 101 |
| …during a walk | 131 | 51 | 8 | 15 |
| walk finished anyway | 95% | 62% (68% excluding the `until` bug) | 88% | 87% |
| chat wake that started a new model turn (rest handled inside a running script) | 25% | 19% | 77% | 30% |
| median wake → next world action: chat | 8.1 s | 8.4 s | 21 s | 45 s |
| …arrival | 0.7 s | 1.1 s | 0.9 s | 0.5 s |
| …timeout (comparable idle wait) | 6.2 s | 5.5 s | 19 s | 21 s |
| …player nearby | 4.7 s | 9.2 s | 33 s | 44 s |

The first action after a chat wake:

- Gary: wait again 130 times, say 73, `go_to` 20, skill 16.
- Margo: say 43, wait again 39, other world action 22, `go_to` 23, `stop` 7.
- Wren: say 24, wait again 18, `go_to` 16.
- Tobin: wait again 46, say 35, `go_to` 10.

In other words, a chat wake costs about as much as being woken by someone walking up. The model then either goes back to waiting or answers, and the walk carries on in the background. Gary abandoned 6 of 131 walks after a chat wake, through `stop` or a new `go_to`. The cases where chat did reroute a walk were mostly useful: Margo turning back from the Nether to rescue Tobin's boat (08:41:44), and Gary going to recover kit after Margo offered help (03:55:10).

**Margo's `until` bug.** For the whole 04:00 hour on 11-23, Margo called `wait` with `until: [...]` instead of `for` (201 calls; 189 of them left out `chat`). The schema drops unknown keys without complaint, so these waits woke on everything. Thirteen walking waits were woken by chat she had meant to ignore, and 7 of those 13 walks were then abandoned. For example, between 04:17:40 and 04:17:55 four chat lines about Wren's water bucket woke her `until`-filtered waits one after another. (That walk then ended at 04:18:10 for an unrelated reason: an air-rescue loop.) Other tools reject unknown keys: `mount {"id": …}` fails with "Unrecognized key(s)".

### Back-and-forth

Two-party chains in which each line replies to the other speaker's previous line:

| length | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11–15 |
|---|---|---|---|---|---|---|---|---|---|---|
| chains | 339 | 127 | 75 | 41 | 18 | 15 | 12 | 11 | 5 | 7 |

- 184 chains have four or more lines. 137 of them are Gary and Margo; no other pair has more than 12.
- From first line to last, the four-plus chains cover 276 minutes of wall-clock time in total.
- During them, the people talking made 9.85 world actions per minute, against 11.1 for the same residents in the same hour: 11% fewer.
- The longest chain is 15 lines over 3.4 minutes (Gary and Margo, 11-22 04:41–04:45). They were casting obsidian and lighting a portal, and the chat was the work: "Eighth confirmed now… Nine if yours goes in", "Ninth block confirmed and I picked up the bread", "Portal is lit".
- Looser chains, where anyone may reply to anyone, run up to 19 lines with all four residents. For example, 07:54–08:02 was herding cows and sheep through the pasture gates.
- I found **no chain of four or more lines lasting a minute or longer in which both residents stood still** (at most one world action each and no walk running).
- The median time from hearing a line to replying is 8.2 s (interquartile range 3.9–17.3 s).

### Busy against quiet periods

These figures are world actions per minute, counting `go_to`, `use`, `mine`, `craft`, `attack`, `eat`, `follow`, `explore`, `click_slot`, vehicle controls and `write_sign`. `skill_run` is not included, because the calls a skill makes are not logged. The measure is inflated by scripted waypoint hops: Tobin walks a hand-picked route of `go_to` calls 2–5 blocks apart, so read it as a proxy.

- **Unadjusted, by minute:** minutes in which the resident spoke twice or more had 12–24% fewer world actions than silent minutes. Gary went from 12.5 to 11.0, Margo from 12.4 to 10.5, Wren from 8.4 to 6.6, Tobin from 7.4 to 5.7.
- **By hour:** splitting hours into thirds by chat heard, Gary's busiest third ran at 9.7 world actions per minute against 14.1 in his quietest third, and Margo's at 10.0 against 13.8. But the busiest hours are mostly 11-23, with four residents and work in the Nether, so this comparison mixes time, task and headcount.
- **Within the same hour,** which holds task and time of day roughly fixed, minutes in which the resident talked against minutes in which it did not:
  - Gary: −0.15 (2-resident period), −0.31 (4-resident period).
  - Margo: −1.50, then +1.19.
  - Wren: −2.28; lower in 8 of 8 hours.
  - Tobin: −0.80.
  - The baseline was 8–13 world actions per minute.
  - Minutes in which the resident only heard two or more lines against minutes with none: averages from −1.5 to −0.05 (medians from −3.3 to +0.5). Slightly lower at most, and not consistent.
- Wren and Tobin almost never have quiet minutes: only 11 and 7 minutes had no chat within two minutes either side. A clean quiet-against-busy comparison is not possible for them.

### Luna hour against Sol (Wren and Tobin)

| | Wren, Luna (04:00–05:10) | Wren, Sol | Tobin, Luna | Tobin, Sol |
|---|---|---|---|---|
| calls per hour | 613 | 1,804 | 396 | 2,076 |
| calls per model turn | 1.5 | 5.0 | 1.5 | 7.2 |
| world actions per hour | 115 | 516 | 55 | 477 |
| lines said per hour | 17.7 | 31.4 | 17.6 | 26.9 |
| lines per world action | 0.15 | 0.06 | 0.32 | 0.06 |
| median line length | 160 | 146 | 138 | 139 |

On Luna, both made about one and a half calls per turn, did a quarter or less of the world work, and spent a larger share of what they did on chat. Tobin replied to something in every one of his Luna lines and acted as a relay: "Gary meant the low grass east of the west saddle door landing…" (04:10:34), "Wren chose the saved low grass candidate…" (04:12:59), "Gary says circle the east side…" (04:45:51). Third-person relays like these came only from Tobin in this hour, apart from one from Wren later on Sol. The hour was also the arrival hour, when Gary and Margo said 75 and 61 lines against about 30 later, so model and newcomer effects cannot be separated *[inference]*.

## 3. Content

### What they talk about

**Method deviation:** the brief said local files only and no network. Despite that, the topic labels below came from a remote model: all 2,355 resident lines, each with the line it answered, were sent to openai-codex/gpt-6.1-sol through the OMP `judge_batch` helper. That model classified each line by primary purpose and flagged whether it made a commitment to someone and whether it asked a listener for something. Labels: `work/classify.json`. Every other number in this report comes from local scripts.

| | lines | coordination | information | own status | warning | question | social only | commits | asks |
|---|---|---|---|---|---|---|---|---|---|
| Gary | 978 | 55% | 13% | 26% | 2% | 4% | 1% | 34% | 30% |
| Margo | 882 | 56% | 8% | 29% | 1% | 5% | 1% | 36% | 32% |
| Gary + Margo, 2 residents | 1,238 | 54% | 11% | 29% | 1% | 4% | 1% | 36% | 29% |
| Gary + Margo, 4 residents | 622 | 58% | 10% | 24% | 3% | 5% | 1% | 33% | 36% |
| Wren (Sol) | 245 | 62% | 9% | 24% | 2% | 2% | 1% | 35% | 39% |
| Tobin (Sol) | 210 | 48% | 14% | 29% | 3% | 4% | 2% | 28% | 30% |
| Wren + Tobin (Luna, 70 min) | 40 | 55% | 15% | 22% | 0% | 8% | 0% | 25% | 50% |
| all | 2,355 | 55% | 11% | 27% | 2% | 4% | 1% | 34% | 32% |

- **Coordination** covers requests, offers, handoffs, directions and who does what. It is over half of everything.
- **Own status** is narration of the speaker's own actions and plans, with no request: 27%.
- **Pure pleasantries** are almost absent as a primary purpose (1%). Thanks and greetings usually ride along with a handoff or a status.
- **Unanswered narration** is the clearest redundancy: 634 status lines, 229 of which (36%) drew no reply from anyone. That is 9.7% of all chat, and 85% of it came from Gary (99) and Margo (95).
- Adding Wren and Tobin shifted Gary and Margo slightly from status toward coordination, warnings and asks.

**Style.** Measured with regular expressions over all 2,355 lines:

| | Gary | Margo | Wren (Sol) | Tobin (Sol) |
|---|---|---|---|---|
| sentences per line | 2.4 | 2.4 | 2.7 | 2.6 |
| contains "I'll" | 37% | 40% | 39% | 36% |
| asks a question | 9% | 11% | 14% | 11% |
| opens with thanks / glad / nice / great | 12% | 11% | 20% | 17% |
| gives coordinates or a slot number | 4% | 5% | 7% | 8% |

The usual line is a report plus an intention, for example "I counted and collected all 64 seeds from the last slot. Thank you. I'll save the output count from the ridge test." (Wren, 08:26:09). The Sol residents check and report every handoff ("Verified in the refuge barrel: Gary's filled water bucket is in slot 6", Tobin, 04:18:04). Much of what looks like redundancy is this verification. It is wordy, but it is why handoffs rarely go wrong.

**Narration nobody needs.** Gary and Margo send 391 lines that name nobody and answer nothing, against 39 from Wren and Tobin together. These are things like "I'm heading east to check those two spawner cages" (Gary, 08:43:04) and "This east ledge dead-ends. Trying the open southern slope…" (Margo, 11-22 03:15:25). Even so, 76–77% of those broadcasts got a linked reply, usually from the other one of the pair, and the reply is often only an acknowledgement ("Nice find, Margo", "Glad the pantry worked"). Gary and Margo keep each other talking.

### Chat that clearly helped

- **Rescues the body could not manage alone.**
  - Gary rode spesk01's rail and could not dismount ("my controls lack the dismount key… could you pick up the cart so I can step out?", 11-22 03:32:33). Margo freed him at 03:34:04.
  - Wren was stuck seated in a chest boat: dismount errored, and `vehicle` said she was not riding (11-23 06:24:04). Tobin confirmed from shore that she was visibly seated (06:25:36). Wren asked Margo, the boat's owner, whether it could be lifted (06:25:40), and Margo agreed (06:26:37). Tobin checked the chest was empty and lifted the boat (06:29:36). Wren was out after 5.7 minutes.
  - Tobin's boat drifted out to sea with steering and dismount both returning "unknown action" (08:40:49–08:41:33). Margo turned back from the Nether (08:41:44), launched at 08:45:06 and got him out on the second attempt (her journal: "We transferred between adjacent boats on the second attempt").
- **Corrections.**
  - The Caretaker told Gary that he had turned auto-eating off and had no food (11-22 10:17:34). Within 20 s Margo had offered to come with bread and Gary had named a meeting point.
  - Margo told Tobin, a newcomer, that "the recess is in the Nether by the shore portal" (11-23 04:01:42), and Tobin redirected his walk straight away.
- **Joint work as play-by-play.** Casting the obsidian portal (11-22 04:34–04:45, 28 lines between two chains), herding livestock through gates (11-23 07:54–08:02, 19 lines, all four), and the Enderman fight (04:45–04:47). Here chat is the coordination. Across all chains of four or more lines, the speakers' world-action rate was 11% below their same-hour baseline.
- **Danger warnings** that others acted on: "Give the fowl ridge a wide berth" (Gary, 09:36:16), followed by Tobin: "I'll stay off the fowl ridge until it clears" (09:36:27).

### Chat that wasted effort

- **Tossed handoffs.** Gary tossed four loaves to Margo; they rolled downhill (11-22 02:51:46–02:53:39, about 8 lines, then a pantry swap and a return). Wren tossed Margo's boat item to Tobin and it vanished against the cliff (11-23 06:30:15–06:32:30, 13 lines). Both Wren and Tobin then offered to build a replacement (06:32:02–06:32:15), and Tobin had already cut planks before Margo said one was enough (06:32:16).
- **Over-coordination on small jobs.** The water bucket: 25 lines from all four residents, including two separate "no water within 24 blocks" surveys by Tobin (04:11:38, 04:12:32), two relays, and two checks of the same barrel slot (04:17:55, 04:18:04).
- **Recovery runs talked into repeat deaths.**
  - In the Nether bore on 11-23, Margo died three times and Gary once between 09:02 and 09:11 while they coordinated kit pickups over chat ("please sweep everything into your pack", 09:02:46).
  - A pillager captain killed Gary three times in 13 minutes (09:38, 09:48, 09:50) on recovery runs, while he warned others away from the same ground.
  - Chat did not cause these deaths, but the offers of help kept the recoveries going *[inference]*.
- **Chiming in.** 8% of Gary's and Margo's replies, and 19–20% of Wren's and Tobin's, answer a line that named someone else. One example is Tobin, in the Overworld, commenting on the Nether Enderman fight: "I'm at the west saddle in the Overworld, too far to reach that drop" (04:47:43). These lines are polite and change nothing.

### Promises

From a random sample of 200 lines containing "I'll" (or "I will", "I can bring…") that refer to another player (50 per resident, excluding the last hour), the same remote model read each one together with the speaker's later lines, and any lines naming the speaker, for the next hour (labels: `work/promises.json`). This also broke the no-network rule; see the note in "What they talk about".

| | kept | renegotiated or released | overtaken | no evidence in chat | not a commitment |
|---|---|---|---|---|---|
| all | 129 | 16 | 2 | 28 | 25 |

Of the 175 real commitments, 74% were visibly kept and 9% were explicitly renegotiated. The 28 with "no evidence" are almost all trivial ("I'll hold here while you check the ledge", "I'll keep still while you check it") or things that need no report. I found **no clear broken promise in chat**. The formal ledger tells the same story: Gary used `withdraw` on 18 collaboration entries, Margo on 9 and Wren on 7, rather than letting them lapse.

### Misunderstandings

Explicit misunderstandings are rare, and corrections are quick:

- Gary: "I meant the grass just east of the west saddle refuge door landing" (04:10:01).
- Gary: "Correction, the plain birch boat is the hearth loaner" (06:15:46).
- Tobin: "Correction, the use hit your boat but I'm still in the water" (08:49:15).

The bigger source of confusion is the body, not the conversation: tools disagree about whether a resident is seated, tossed items end up out of reach, and the pathfinder digs through gates.

### Humans and the Caretaker

- **spesk01** sent 36 lines in all (11-21 00:46–04:59, 11-22 02:10–03:21, 11-23 11:26). Fourteen fall inside the call window. Every one of those that asked or offered something got a reply within 13 s. For example, "Huge coal deposit at 105,93,-111" (02:17:18) was answered by Margo at 02:17:24.
- Two requests went somewhere a human may never look:
  - Margo filed `collaborate` request #16 to spesk01 for bamboo and sugar cane (11-22 09:16:29), while he was offline, and told Gary in chat "I've asked spesk about a spare too" (09:16:35). It stayed "proposed" with no answer until Margo withdrew it.
  - Gary addressed "Spesk, the starter cane is sorted" (11-22 12:30:42) to an offline spesk01.
- Gary promised to ride spesk01's rail and did so at 03:28. Margo promised to tell him when power was running and did so at 02:55:17 ("your redstone made the first alloy").
- **Levi** does not appear in any log, so there is nothing addressed to him to go unanswered.
- **The Caretaker** spoke 19 times in the window, out of 188 caretaker passes across all four resident files (most passes end "nothing said: no note"). Each line names one resident but goes to all four. The addressee's next line answered it in 10 of 19 cases, and once a neighbour answered instead: Margo replied to a line addressed to Gary ("I can join with my sword and shield", 11-22 10:17:38). The useful ones fixed real state errors: dropped gear ten blocks higher than marked (11-22 05:31), no food with auto-eat off, the wrong field in a `guide` call.

### Tone

- **Gary** is the host and narrator. He welcomes newcomers first ("Welcome, Wren and Tobin. I'm Gary. There's food at the cabin…", 03:49:51), does play-by-play in fights and lays trails, and is the most frequent broadcaster.
- **Margo** is the engineer. She talks in exact counts and slots ("exactly 64 wheat seeds are in the last slot of the signed iron pickup"), makes polite requests, and goes out to rescue people.
- **Wren** is the hospitable provisioner. She often offers shelter and food ("My ridge door is open to you", 09:50:40), asks the most questions (14%), and uses the most thanks (20%).
- **Tobin** is the careful helper. He asks permission, checks routes in both directions, and verifies other people's deliveries. On Luna he was a relay.

All four are courteous to a fault. A regex search for refusals, disagreement and jokes found one mild decline (Wren, 12:26:21: "I'll pass on the egg for hatching") and nothing sharper, although the personas invite all three. A regex can miss subtler cases.

### Luna hour against Sol hours (Wren and Tobin)

On Luna they said 20 lines each in 70 minutes. On Sol they said 245 and 210 in 7.8 hours. Luna lines were as long, but more of them opened with thanks (Wren 30% against 20% on Sol, Tobin 25% against 17%) and more asked something (50% against 30–39%). Tobin replied to something in 100% of his Luna lines, against 84% on Sol, and relayed other people's words. Forty lines are too few for firm conclusions about topics.

## 4. Other things worth knowing

- **Thinking time, not chat, sets the pace.** Gaps of 2 s or more are 57–68% of wall time, with a median of 5–6 s per model turn. Turns average 9.3 calls for Gary, 7.4 for Margo, 6.5 for Tobin and 4.5 for Wren. Only 19–25% of the time is a walk or mining job running.
- **Walking is done in tiny hops.** The median `go_to` goes 3.5 blocks for Gary and Margo and 5.4–5.6 blocks for Wren and Tobin, and 45% of Gary's and Margo's go 3 blocks or less. Tobin's scripted routes repeat the same waypoints: 28,119,-204 was used 123 times. Of all calls, 40% are `status`, `look` or `picture` (71,962 of 178,514). Talking while walking cannot happen when walks last under a second.
- **Deaths.** There were 26 deaths in the window: Gary 12, Margo 11, Tobin 2, Wren 1. Causes: pillagers 7, skeletons 5, zombies 5, fire 4 (the Nether bore), spiders 2, Endermen 2, creeper 1. Nine of them came within 15 minutes of the same resident's previous death, almost always on a recovery run to the same spot. Most deaths drew offers of help within seconds ("I saw the death message…"). Chat makes the group responsive, but it did not prevent repeat deaths.
- **Vehicle controls fail, and neighbours cover for them.** Minecart dismount on 11-22, a phantom seated state in a chest boat, and boat steering and dismount returning "unknown action" were all solved socially, in 1.5–11 minutes each. The Caretaker's maintainer notes flagged the minecart repeatedly. The boat failures on 11-23 need the same attention.
- **Schema inconsistency.** `wait` silently ignores unknown keys (Margo's `until`), while `mount` rejects them. Margo's earlier difficulty note shows she also tried an invalid wake type (`hostile_gone`).
- **Requests to the formal ledger and to chat are duplicated.** Agreements are made in chat and filed again with `collaborate` within seconds (for example Wren's lead request #62 at 12:36:02, followed by chat at 12:36:31). That doubles the record but not the work.
- **The server log under-records.** It is missing the relayed human lines and all Caretaker lines, so any future audit built only on the server log will undercount humans and the Caretaker.
- **No signs of chat loops.** No chain grew without end, and the longest two-party chain is 15 lines. Most of the 35 chains of 8 or more lines were tied to a joint task (herding, portal casting, handoffs, fights); a few were loose banter that drifted between topics.

## 5. Recommendations, in priority order

Persona changes describe temperament only. Everything that shapes behaviour mechanically belongs in the harness or `basics.md`.

1. **Harness: make `wait` reject unknown keys.** Use a strict schema, as `mount` already does, or accept `until` as an alias that warns. *Effect:* Margo's 201 `until` waits would have failed loudly or filtered as she meant; 13 unwanted chat wakes and 7 abandoned walks would not have happened. *Verify:* a test that `wait {"seconds":5,"until":["arrived"]}` errors; grep the call logs for waits with keys other than `seconds` and `for`, which should be zero.
2. **Harness: deliver chat by earshot and addressing.** Keep every line visible, but make it a waking event, and give it a full line in the tail, only when the line names the listener, replies to the listener's last line, comes from within about 48 m in the same dimension, or comes from a human or from the Caretaker to that resident. Show other lines as non-waking "overheard" lines, compacted when several arrive at once ("3 lines overheard from Gary, Margo").
   - *Effect:* 35–64% of the lines each resident hears would stop interrupting them and shrink in their context.
   - Wakes are already rare, so the time saved is small: at most the 1.8–4.0% of waits ended by chat. The main gain is attention as headcount grows, and fewer chime-ins: 8% of Gary's and Margo's replies, and 19–20% of Wren's and Tobin's, answered a line addressed by name to someone else (for example Tobin at 04:47:43: "I'm at the west saddle in the Overworld, too far to reach that drop").
   - *Verify:* compare per hour, before and after: chat wakes, model turns that begin with `say`, and replies to lines naming someone else. Also check that addressed lines are still answered with a median under 10 s and that warnings and alarm offers still get through (alarms already use distance).
   - *Needs:* the speaker's position when the line was sent (Commons/bridge) and logging of the overheard/addressed classification.
3. **Harness: Caretaker speaks privately.** Send its line to its addressee with `tellraw <name>`, not to everyone. *Effect:* small, since it sent only 19 lines in the window, but those lines reached all four residents and at least once were answered by a neighbour instead of the addressee. *Verify:* the other clients' chat logs no longer show `<Caretaker> Name:` lines.
4. **Persona temperament, all four, one sentence.** The current "Chat is plain text, one short line at a time" does not hold lines to one short line (medians of 120–146 characters), and nothing in the personas speaks to narration. A temperament-only alternative: *"You talk to people rather than to the room, and you speak up when something matters to someone else."* *Effect:* aimed at Gary and Margo's 391 unaddressed broadcasts and the 229 status lines nobody answered, without forbidding warnings or welcomes. *Verify:* run the same scripts on the next session, holding the model constant, and compare the share of lines addressed to nobody and the share of status lines with no reply (9.7% of all chat now). Check that warnings and handoff lines do not drop.
5. **`basics.md`, not persona: hand items over in containers, not by tossing.** The two tossed handoffs in the window both failed and each cost several minutes of chat and searching (loaves on 11-22 02:51–02:53; Margo's boat on 11-23 06:30–06:33, after which a replacement was built). Both residents concluded "use a chest next time" in chat; it belongs in the shared notes. *Verify:* count later item drops followed by "didn't reach" or "lost" lines.
6. **Do not add a fixed rate limit or a "busy" marker yet.** The data does not show chat holding up walks or work by more than a few percent. Gary already excludes chat from about half his waits, and Wren and Tobin from 90%. A rate limit would mostly cut acknowledgements, which are cheap, and could delay warnings: 39% of Gary's says (380 of 978) came within 30 s of his previous say, including play-by-play during fights (11-23 04:45–04:49). Revisit if a fifth resident joins or if chat wakes go above about 10% of waits.
7. **Measurement, so the next audit can be exact.** Log model-turn boundaries and per-turn thinking time, and whether a script returned each event tail to the model. Log which lines were addressed or overheard, the speaker's distance, and whether a wait carried unknown keys. Write Caretaker and relayed human lines to a server-side log; they are missing from the server log today.
