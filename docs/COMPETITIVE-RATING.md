# Competitive position — measured, not asserted

> **Against the actual field:** this document rates FlowMesh against the 145-repo OSS
> corpus. For the 18 live repos built for this challenge, with per-axis scores and a
> verified event-relevance check, see [`COMPETITIVE-RATING-LIVE.md`](COMPETITIVE-RATING-LIVE.md).

This is a self-assessment written by the person who built it, against evidence gathered
from **145 public repositories** in the Wispr Flow and on-device-dictation space
(`.research/seed_repos.md`) and a source-level read of the strongest ones
(`.research/findings/code-skim.json`, `.research/clones/`).

**What this document does not do.** It does not rank the submissions and it does not
predict a placement. We have not seen the other entries in the Builders track, we do not
know the judges' weights, and the weights the public page renders show `0%`, which is not
a number anyone should cite. Any claim of "top 1" would be invented. What follows is what
can be defended line by line.

## Who is actually in the field

The 145 repos are three different things, and conflating them is the most common mistake
in this challenge:

| Group | Examples (verified from clone `LICENSE` files) | What they really are |
| --- | --- | --- |
| **Dictation products** | VoiceInk (GPL-3.0), freeflow (MIT), SayIt (AGPL-3.0), SpeakoFlow (MIT, ~141k lines Rust, a Handy fork), openflow (MIT, Handy fork), whisper-typing (MIT), whishpy (MIT) | They **are the** dictation layer: STT, streaming, VAD, text injection. Mature, polished, years of work. |
| **Wispr data utilities** | WisprMCP (MIT, 31 files / ~4.7k lines) | Reads Wispr Flow's local database to expose history. The only prior art for the integration this submission is built on. |
| **Voice→action entries** | KMKnation/SpeechToAction (MIT, Java, 408 lines, 3 files, 2018) | Speech recogniser with a bounded command vocabulary, firing OS actions. |

The third group is the actual competitive set for a *"No Hands"* challenge. Everything in
group one is a different product category, and FlowMesh deliberately does not compete with
it — it has no audio capture by design, because Wispr Flow is the dictation layer.

## The decisive difference, quoted from their source

KMKnation/SpeechToAction, `src/main/Command.java:113–193`, from our code read:

> `performAction` … is a chain of `action.contains('google')` / `contains('close')`
> substring checks with **NO plan, NO confirmation, NO receipt, and NO allowlist** —
> `'close'` immediately fires `Alt+F4` at :180–191.

One spoken word closes the foreground window. FlowMesh's answer to the same input is a
bounded plan (max steps, allowlisted actions), an approval that expires in 300 seconds,
a plan that runs exactly once, and a per-step receipt that says `sent`, `verified`, or
`not_configured`. Nothing in the harvested corpus does this. That is not a feature
comparison; it is a different safety model, and it is the one thing a judge cannot get
from any other entry.

## Head-to-head on the judges' four published questions

| Question | FlowMesh | Strongest rival evidence |
| --- | --- | --- |
| **Is there a real problem in your work?** | Dictated intent → repeated manual steps. The demo uses a real sentence pulled from the author's own Wispr history. | Every group-one project is a better *dictation* tool and says nothing about what happens after the words appear. |
| **Is Wispr used meaningfully?** | Reads `flow.sqlite` with `?mode=ro`, shows provenance (`last dictated into chrome · 8s ago · read-only`), and degrades honestly when the file is `not_found`, `locked`, or has an `unexpected_schema`. | WisprMCP reads the same database but connects **read-write** (`sqlite3.connect(str(self.db_path))` at `wispr_mcp/core/parser.py:35`, no `?mode=ro`, no `busy_timeout`) and hardcodes the macOS path. |
| **Does it work, can a judge open and use it?** | Live Netlify console, four release artifacts (portable Windows `.exe`, arm64 `.dmg`, x86_64 `.AppImage`, Windows Python zip), 7/7 CI jobs green on the released SHA, 84 Python + 41 Node tests. | Group-one projects are source-only for most judges: no hosted link, no downloadable build for the judge's OS. |
| **Is the demo clear?** | **Currently zero — no video exists.** A shot list is written (`docs/DEMO-SCRIPT.md`) and every beat in it is something the build does. | Nothing to compare: rival entries we could read do not ship demos we could assess. |

## Where we lose, plainly

1. **The demo question is unanswerable right now.** The single highest-value action left
   costs two minutes of filming and nothing else. Until it exists, this entry scores as
   "good repo, no demo".
2. **Dictation quality: we are not in the race, and should not pretend to be.** VoiceInk,
   freeflow and SayIt do streaming, VAD, and injection polish that FlowMesh will never
   match, because FlowMesh does not do dictation at all. If a judge reads "Wispr
   alternative", that is a misread we must prevent in the pitch.
3. **The build-process requirement is not yet evidenced.** The challenge asks for Wispr
   used while *building*. The repo shows the product's use of Wispr; it does not yet show
   the build-process use. That is a documentation gap, not a product gap, and it is the
   user's own material to supply.
4. **Every group-one project is a real, installable app for normal users.** FlowMesh's
   desktop surfaces are honest but thin by comparison: no installer flow, no onboarding,
   unsigned binaries, macOS artifact arm64-only.
5. **Platform truth:** macOS and Linux artifacts are CI-built and were never run by a
   human. Saying so costs credibility points; not saying so would cost all of them.

## Verdict, in plain terms

Without the video, this is a strong engineering entry that cannot win a challenge whose
fourth question is "is the demo clear". With the video, the honest position is: **the
safety model and the real Wispr integration are unmatched in the corpus we could read,
the polish is mid-field, and nothing here is fabricated.** That is the shape of a
contender, not a guaranteed winner, and the difference between those two sentences is
exactly the material only the submitter can produce.

## What would move it up, in order

1. **Record the 2-minute video** from `docs/DEMO-SCRIPT.md`. Nothing else changes the
   judge's experience as much per minute spent.
2. **Add the genuine Wispr Insights usage-card screenshot** and one paragraph on the real
   work problem, in the submitter's own words.
3. **Document the build-process use** — the dictated requirements and follow-ups that
   drove this build — from the submitter's actual session history.
4. **Rehearse the pull once on the recording machine**, because the freshness window is
   five minutes and the demo depends on it.
5. Optional, if time allows: a 20-second screen recording of the hotkey path replacing the
   button clicks, since "no hands" is the challenge's name.
