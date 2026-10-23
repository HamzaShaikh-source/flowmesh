# Wake word

Say **"Hey FlowMesh"** and FlowMesh reacts, optionally by pressing your Wispr Flow shortcut so Wispr
starts listening. It is opt-in, local and Windows-only for now.

## How it works

- **Offline detection.** The desktop runtime starts one fixed PowerShell script that uses the speech
  recogniser built into Windows (`System.Speech`). It loads a tiny grammar ("hey flow mesh", "hey
  flowmesh", "okay flow mesh") plus general dictation as a decoy, so other speech is not forced onto the
  wake phrase, and it only reports a wake when the phrase wins with confidence of at least 0.82. No
  audio leaves the computer, nothing is transcribed or stored, and the script never prints what it heard.
  A browser speech API was rejected on purpose: it would stream everything you say to a third party,
  and the Electron build does not have one.
- **Opt-in every launch.** It never starts by itself. Turning it on (Wispr page, **Wake word**) asks for
  an explicit acknowledgement that your microphone stays open; a "wake on" badge shows in the voice dock
  while it listens; it stops when you switch it off or quit. `FLOWMESH_WAKE=off` disables it.
- **A wake only wakes.** The page plays a soft chime, shows a cue and opens the Flow page. If you saved a
  Wispr shortcut, the runtime also presses it (a 6 second cooldown swallows repeats). Wispr then does the
  dictation, and FlowMesh's normal live pickup plans what you said. Plans still need your approval.
- **The shortcut is not free text.** It is parsed from a strict grammar: one to three modifiers
  (`ctrl`, `alt`, `shift`, `win`) plus one key (letter, digit, F1-F12, space, enter, tab), at most four
  keys. It is sent only as virtual-key presses to whichever window has focus, and **Test it in 3 seconds**
  lets you click into the right window first.

## Honest limits

- Windows only for now; other systems report "not available". It needs a speech recogniser installed
  (English is by default on most Windows installs).
- **Verified here:** the recogniser starts on this machine's microphone and the page shows `listening`
  with the badge; the parser, states, cooldown, routes and error handling are tested in both runtimes
  with a fake recogniser. **Not verified:** that it actually hears "Hey FlowMesh" from a person
  (no one spoke to it), its false-wake and missed-wake rates, or that pressing a real Wispr shortcut
  starts Wispr dictation.
- Wispr's shortcut may use keys Windows cannot synthesise (for example Fn), may be push-to-talk
  (use the hold time) or hands-free toggle (tap), and some apps ignore synthetic key events.
- Anything in range of the microphone can say the phrase (a video, a call). Wake does not approve
  anything; at most it starts a dictation you still have to approve.
