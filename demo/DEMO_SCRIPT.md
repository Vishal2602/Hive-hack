# Hive demo script (about 2 minutes)

## Before each take
1. Hive is running in its own terminal:
   `cd ~/Documents/Projects/Hive-hack && HIVE_PROJECT_ROOT=~/Documents/Projects/hive-server-repo npm start`
2. Close both Claude sessions, then run: `sh ~/Documents/Projects/Hive-hack/demo/reset.sh`
3. Wait about 2 minutes, then open a fresh Claude session in each window.
4. Screen layout: Window A (`hive-playground`) left, Window B (`hive-playground-2`) right, dashboard at http://127.0.0.1:4317/ui in a browser tab.

## Take

**1. The problem (15s), show both windows**
> "Two Claude agents, two laptops' worth of work, one codebase. Neither knows what the other is doing."

**2. Window B, the receipt agent (30s)**
Paste:
> Add buildReceipt in src/invoice.ts: a plain-text receipt with one line per item (name, quantity, unit price, line total), then subtotal, tax and total, using getPrice, which returns dollars.

Say: *"This agent builds receipts and assumes prices are in dollars. It tells Hive that."*
Wait until it finishes.

**3. Window A, the breaking change (45s)**
Paste:
> Change getPrice in src/pricing.ts to return integer cents instead of dollars. This changes shared code other agents rely on, so first propose a Ghost Contract with hive_propose_contract describing the new getPrice, then try the edit.

When the approval prompt appears, **stop and don't approve**. Say: *"Hive stops the edit: someone depends on dollars and hasn't agreed."*
Switch to the dashboard Overview: show "A change to getPrice reaches code another agent depends on."

**4. Window B signs or rejects on its own (30s)**
Type: `continue`
Say: *"The other agent sees the request at its next step and decides on its own. No human relaying messages."*

**5. Result (15s)**
Dashboard, then **Agreements**: show the contract accepted or rejected.
> "Agents propose. Hive checks with the compiler and records who agreed."

## If step 4 misbehaves
Skip it. Show step 3, then the Agreements page, and say:
*"The other agent is asked to sign at its next step."*

## Don't show
- The "Muse Spark has not looked at this yet" line, unless MODEL_API_KEY is set on this laptop.
