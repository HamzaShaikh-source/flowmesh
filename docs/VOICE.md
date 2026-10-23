# Voice: using Wispr Flow inside FlowMesh

FlowMesh does not contain a speech engine, and Wispr Flow has no public dictation API, so
FlowMesh cannot embed Wispr's engine. What it can do, and does, is **watch Wispr's own local
history** (read-only) and treat each new dictation as input, so you can hold your Wispr key
anywhere in the FlowMesh window and talk.

## What happens when you talk

1. You hold your Wispr key and speak. Wispr transcribes and writes the dictation to its history.
2. If the text went into a text field FlowMesh owns (the command box), it is already there and
   FlowMesh does nothing extra.
3. Otherwise, within about two seconds, FlowMesh picks up the new dictation:
   - If it is exactly a **voice command** ("cancel", "go to tools", "read it back"), it acts.
   - If it is anything else, it opens **Flow**, fills the command box (with its provenance line),
     and, if *Plan automatically* is on, creates the plan.
4. The plan waits on screen. **Nothing runs until it is approved.**

Live pickup needs the desktop app (it reads a local file), only acts while the FlowMesh window is
focused, only on dictations from the last 30 seconds, and never on history that pre-dates the
page being opened. The Wispr page shows exactly what was picked up.

## Voice commands

Only a **whole utterance** that matches one of these acts as a command (case, punctuation, a
leading "hey flowmesh" and a trailing "please" are ignored):

| Say | Does |
| --- | --- |
| "go to tools" / "open history" / "show me the settings" / "take me to about" | opens that page (home, flow, tools, wispr, history, settings, about) |
| "cancel" / "never mind" / "stop" | cancels the plan on screen |
| "read it back" / "what's the plan" | speaks the plan summary |
| "new plan" / "start over" | clears the command box |
| "add a tool" / "connect a server" | opens Tools |
| "approve" / "approve and run" / "go ahead" | approves the plan on screen, **only if you turned this on** and the plan qualifies |

"Cancel my subscription", "approve the quote and send it to Rohan" or "go to tools and delete
everything" are **not** commands: they are ordinary sentences and become a normal plan. There is
no fuzzy matching, and nothing in the grammar can name a tool, a path or an argument. The grammar
is a pure module (`web/voice-grammar.js`) with adversarial tests.

### Approving by voice

Off by default, because a video or a call could say "approve". When on, it works only if the plan
is on screen, less than two minutes old, has no `danger` call, does not need the second
confirmation, and is not already running. Danger plans always need a click and their checkbox.

## Driving the hosted site with Wispr (the voice harness)

The hosted page cannot read Wispr's local history, but Wispr Flow types into whatever field has focus. So
on the hosted page the dock has a **capture field** that keeps focus whenever you are not editing something
else: hold your Wispr key, talk, and the words land there. A pause of about a second and a half (or Enter)
sends the sentence on. It is then treated exactly like a spoken sentence: a *whole utterance* that matches a
fixed command acts on the page; anything else is planned as a normal command and waits for your approval.
Click into any other field and it steps aside; Escape leaves it; the dock's Wispr button turns it off.

Say **"what can I say"** for the list, which is generated from the same data the grammar uses. In short:

| Area | Examples |
| --- | --- |
| Go anywhere | "go to tools", "open history", "show the code page" |
| Plan | "create the plan", "focus the box", "new plan", "try the research sprint example" |
| Approve safely | "read it back", "cancel", "approve" (only if you turned it on; never for danger plans) |
| Results | "open the latest run", "copy the record", "download the record", "plan the next step" |
| Tools | "use the calculator tool", "set expression to 12 times 3", "add to the chain", "plan this call", "plan the chain", "clear the chain" |
| The page | "open the palette", "scroll down", "go to the top", "start reading aloud" |

How it stays safe:

- Commands carry a type and an item from a fixed list (a page, an example, a tool). Nothing can name a path,
  a program or a setting, and **no command can switch approval-by-voice on**: that is only a checkbox.
- Every action presses the same button a person would, so the plan gate, the single-use plan, the danger
  confirmation and the five-minute expiry all still apply. Saying "plan this call" never runs anything.
- The one command with free words is `set <field> to <words>` (also "fill", "enter", "type"). It exists only
  while a tool form is open, writes only into that visible form, and the result is still a plan. When no field
  matches, the sentence is planned instead, so "set the desk lamp to 40 percent" is never swallowed.
- Spoken operators in the calculator are converted ("times", "plus", "minus", "divided by").
- On the **desktop app** the capture field is hidden: live pickup already reads Wispr's history, and the same
  commands work there too.

## Reading results aloud

*Read plans and results aloud* uses the device's speech synthesis. It speaks only FlowMesh's own
summary ("Plan: Tool call. 2 steps. Highest risk write. Review it on screen." / "Run complete: 1
verified, 2 returned."), never raw tool output.

## The microphone button

An optional fallback for browsers that have `SpeechRecognition`. **Its audio goes to the browser
vendor's speech service, not to FlowMesh and not to Wispr.** The desktop app's Electron engine ships
without such a service, so there it reports an error and points back to Wispr; Wispr (hold its
key) is the reliable voice path in the desktop app. The hosted page allows the microphone for
itself only (`Permissions-Policy: microphone=(self)`); the Electron app denies every permission
except audio capture for its own page.

## Settings

Stored in the browser's local storage on your machine: live pickup (on), plan automatically (on),
voice commands (on), approve by voice (off), read aloud (off).

## What was and was not verified

- Verified with a synthetic Wispr database written the way Wispr writes it: a new dictation was
  picked up, planned, cancelled by voice, refused when approve-by-voice was off, approved by voice
  when on, and refused for a danger plan.
- The grammar is covered by unit tests, including sentences that contain command words.
- **Not verified:** a real Wispr key press (the synthetic rows imitate Wispr's writes), the mic
  button in a real browser or in the Electron app, and speech synthesis output (a device feature).

### What was verified for the harness (23 October 2026)

In the real page, with a browser-mode session and real key events typed into the capture field: "go to tools"
navigated; "use the calculator tool" opened the builder; "set expression to 12 times 3 plus 4" filled
`12 * 3 + 4` and kept focus in the capture field; "plan this call" created a plan; "approve" was refused while
voice approval was off and the plan stayed pending; the plan was approved with a click and returned a
receipt; "what can I say" opened the help sheet; an ordinary routine sentence became a normal plan.
**Not verified:** a real Wispr key press into the field (Wispr inserts text with its own timing, so the
1.5 s pause is a guess to tune), speech synthesis output, and screen-reader behaviour of a field that holds
focus (Escape and the dock toggle are the ways out).
