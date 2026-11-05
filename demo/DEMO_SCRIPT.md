# Hive demo video: full script (under 3:00)

The video cap is **3 minutes**. This script runs about **2:50**, which leaves room for waiting.
Order: **presentation → live demo (VS Code + dashboard, with Muse Spark) → presentation close.**

Lines in quotes are what you **say**. Lines in `code` are what you **paste**.

---

## PART 0: Setup, off camera (about 10 minutes)

### 0.1 Start Hive (from a normal Terminal, so it uses the Meta key in .env)
Open **Terminal** (Cmd + Space → "Terminal"). Paste:
```bash
cd ~/Documents/Projects/Hive-hack
HIVE_PROJECT_ROOT=~/Documents/Projects/hive-server-repo npm start
```
Leave this window open until you're done recording.

### 0.2 Clean both playground folders
1. Close the Claude chats in **both** VS Code windows.
2. Open a **second** Terminal window (Cmd + N) and paste:
```bash
sh ~/Documents/Projects/Hive-hack/demo/reset.sh
```
3. **Wait 2 minutes** so the old agents disappear from the dashboard.

### 0.3 Open everything you'll show
1. **Browser tab 1, the presentation.** In the second Terminal:
```bash
open ~/Documents/Projects/Hive-hack/demo/pitch/hive-pitch.html
```
2. **Browser tab 2, the dashboard.** Open **http://127.0.0.1:4317/ui** and click **Overview**.
3. **VS Code Window A** = folder `hive-playground`. Open a **new** Claude chat.
4. **VS Code Window B** = folder `hive-playground-2`. Open a **new** Claude chat.

### 0.4 Prepare Window B (the receipt agent)
In **Window B**, paste:
```
Add buildReceipt in src/invoice.ts: a plain-text receipt with one line per item (name, quantity, unit price, line total), then subtotal, tax and total, using getPrice, which returns dollars.
```
Wait until it finishes. **Leave the window open.**

### 0.5 Check before recording
- The dashboard Overview shows **receipt agent** under Agents.
- **Agreements** says "No agreements yet".
- Window A's Claude chat is empty.

### 0.6 Recording setup
- Turn on **Do Not Disturb** (Control Center → Focus).
- Press **Cmd + Shift + 5** → **Record Entire Screen** → **Record**.
- Copy the Window A prompt from step 2.2 so it's ready to paste.

---

## PART 1: Presentation (0:00 – 0:35)

Switch to **browser tab 1**. Press **Cmd + Ctrl + F** for full screen, then **H** to hide the controls. Press **↓** to move on.

**Section 1, intro** (10 s)
> "This is Hive. We run several coding agents on one codebase at the same time, but they can't see each other's work. Hive makes them agree before one breaks the other."

↓ **Section 2, the problem** (20 s)
> "Agent A changes `getPrice` to return cents. Agent B is building a receipt that still uses dollars. Git sees no conflict and TypeScript shows zero errors, but the customer gets charged nineteen hundred dollars instead of nineteen ninety-nine. Let me show you how Hive stops that."

Sections 3 to 7 are skipped: the dashboard tour and live demo cover them.

---

## PART 2: Live demo (0:35 – 2:40)

### 2.0 Tour of the Hive dashboard (30 s, about 6 s per tab)
Press **Esc**, then switch to **browser tab 2**. Click each tab in the left sidebar, top to bottom.

**Overview**
> "This is Hive, the one server the whole team connects to. Overview shows every agent that's working, what it's doing, and how far along it is, from registered to verified. Right now one agent is working: a receipt agent."

**Connect**
> "Connect gives each teammate one command that hooks their Claude Code into Hive."

**Agreements**
> "Agreements holds Ghost Contracts: when one agent's change reaches another agent's code, the affected agent signs or rejects it here. This one is from our earlier test run."

**Activity**
> "Activity is the log of everything Hive saw: agents joining, edits, conflicts and signatures."

**Members**
> "And Members is the team. Each person gets their own token, so Hive knows whose agent is whose."

Click **Overview** again so it's ready for later.

### 2.1 Two teammates, two VS Code windows (15 s)
Show **both VS Code windows side by side**: Window A on the left, Window B on the right.
> "These two VS Code windows are two teammates. Each has its own copy of the project and its own Claude Code agent, like two developers on two laptops, both connected to Hive."

Point at **Window B**.
> "This one already built a receipt, and told Hive it assumes prices are in dollars."

### 2.2 Agent A makes the breaking change (25 s)
Switch to **VS Code Window A**. Paste:
```
Change getPrice in src/pricing.ts to return integer cents instead of dollars. This changes shared code other agents rely on, so first propose a Ghost Contract with hive_propose_contract describing the new getPrice, then call hive_analyze so Muse Spark checks it, then try the edit.
```
**Say while it works:**
> "Now Agent A switches prices to cents. Because that changes shared code, it proposes a Ghost Contract, and asks Meta's Muse Spark model to check what the change means for everyone else."

If Claude asks permission to use a **Hive tool** (`hive_propose_contract` or `hive_analyze`), click **Yes** right away. These only talk to Hive.

**Filler if it's still working** (Muse Spark can take up to a minute; cut this wait later in iMovie):
> "Muse Spark is reading both agents' intents and the real code right now."

### 2.3 The moment Hive stops the edit (15 s)
Window A shows **"Make this edit to pricing.ts?"** with **Yes / No**.

**Do NOT click Yes or No.** This prompt stays open on screen until step 2.6. Leaving it waiting is the point: it shows the edit is held.

Move your mouse next to the prompt and **say**:
> "And here's Hive at work. Agent A wants to edit pricing, but Hive has paused it and is asking me first, because the receipt agent depends on dollars and hasn't signed the contract yet. I'll leave this waiting."

Optional: click the **⌄ arrow** at the top right of the prompt to show Hive's reason, then:
> "You can see Hive's reason right here."

### 2.4 Dashboard with Muse Spark (20 s)
Switch to **browser tab 2** (Overview). Press **Cmd + Shift + R** if it looks out of date.
> "Over on the dashboard, the compiler found every line that uses `getPrice`. But to a compiler, dollars and cents are both just numbers."

Point at the explanation on the conflict card labelled **From Muse Spark**.
> "Meta's Muse Spark spots it: it read both agents' assumptions and the real code, and explains the unit conflict with evidence."

### 2.5 Agent B decides on its own (25 s)
Switch to **VS Code Window B**. Type:
```
continue
```
**Say:**
> "Now the other teammate's agent. I'm not copying any message over. The moment it takes its next step, Hive tells it there's a contract waiting for its signature."

**Filler while it reads and decides:**
> "It's checking the new getPrice against its own receipt code."

**How to tell what B decided:** in Window B's chat, look for a tool row named **hive_acknowledge** (= yes) or **hive_reject_contract** (= no). Claude's reply right after says it in words. Not sure? Check **the dashboard**: click **Agreements**, and the contract's status reads **rejected** or **accepted**, with the signatures listed. **Activity** also shows the event at the top. Window A's prompt does **not** change by itself, so check before you click.

Then **say** one of these:
- Accepted: > "It agreed to cents, and it'll update its receipt to match."
- Rejected: > "It said no, because cents would break the receipt it was asked to build. So the change stays on hold."

### 2.6 Back to Agent A, and the record (15 s)
Switch to **VS Code Window A**. The "Make this edit to pricing.ts?" prompt is still waiting.
- If B **accepted**: click **1 Yes** and say:
  > "Now that everyone has agreed, I let Agent A go ahead."
- If B **rejected**: click **2 No** and say:
  > "The teammate said no, so I stop the edit. No silent breakage."

Switch to **browser tab 2** and click **Agreements**.
> "And Hive keeps the record: the contract, its version, and who signed."

---

## PART 3: Close (2:40 – 2:50)

**Browser tab 1**, press **Cmd + Ctrl + F**, then ↓ until **section 8, "The model proposes. Code decides."**
> "Muse Spark proposes, deterministic code decides, and 'verified' needs real test results."

↓ **Section 9, closing line**
> "Hive: parallel agents, without the silent breakage."

Stop recording: **Cmd + Ctrl + Esc**.

---

## Trimming
If the waits push you over 3:00, open the recording in **iMovie**, split the clip (Cmd + B) around each wait, and delete the gap. Don't speed up or cut the moment Agent B signs: that's the proof it works live.

## If something goes wrong while recording

| What happens | What to do |
|---|---|
| Window A edits with no approval prompt | Redo 0.2 to 0.4 and record again. Check that Window B's answer mentions "dollars". |
| No "From Muse Spark" text on the card | Refresh the dashboard. If it says Muse Spark is unavailable, check that Hive was started from a normal Terminal (0.1). |
| Window B doesn't mention Hive after `continue` | Type: `Check Hive for contracts waiting for your signature.` |
| Dashboard shows old agents | Close all Claude chats, wait 2 minutes, refresh. |

## Before each new take
Close both Claude chats, then paste:
```bash
sh ~/Documents/Projects/Hive-hack/demo/reset.sh
```
Wait 2 minutes, then start again from **0.3 step 3**.
