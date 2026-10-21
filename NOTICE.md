# NOTICE — third-party influence and attribution

FlowMesh is MIT licensed (see `LICENSE`). During development we read 145 public
repositories built around Wispr Flow and around on-device dictation, and we took
**ideas and interface techniques** from that reading.

**No implementation source code from another project is present in FlowMesh.** That is
not a claim made from memory: `.research/` holds 23 saved reference snippets, and a
line-by-line comparison of their distinctive lines against this source tree finds exactly
one identical line —

```js
const { DatabaseSync } = require('node:sqlite');
```

— which is the import statement for Node's own built-in SQLite module, the only way to
call that standard-library API, and not copyrightable expression.

## Projects consulted

Ideas drawn from these appear as independent implementations. Nothing here is a vendored
dependency of FlowMesh, and none of their code ships in the build.

| Project | License | What influenced FlowMesh |
| --- | --- | --- |
| [pedramamini/WisprMCP](https://github.com/pedramamini/WisprMCP) | MIT | The starting premise that Wispr Flow's local `flow.sqlite` can be read at all, and that a dictation's row identity is `transcriptEntityId`. Our reader differs substantially: Windows and macOS paths, `?mode=ro` instead of `immutable=1` (which serves stale data and ignores the WAL), column intersection against the real schema, two runtimes pinned by a contract test, and provenance kept server-side. |
| [Beingpax/VoiceInk](https://github.com/Beingpax/VoiceInk) | GPL-3.0 | Interface patterns only — a status strip that reports connector health, and a pull-then-edit box. No code copied; GPL-3.0 code was deliberately not carried over. |
| [crosswk/SayIt](https://github.com/crosswk/SayIt) | **AGPL-3.0** | The idea of a global hold-to-talk key and a resident tray app. Reimplemented with Electron's `globalShortcut` and `Tray` APIs. No code copied, and no AGPL-3.0 code was read into this implementation. |
| [zachlatta/freeflow](https://github.com/zachlatta/freeflow) | MIT | The technique of injecting text at the focused cursor rather than via the clipboard. Reimplemented per platform (`keybd_event` on Windows, AppleScript on macOS). |
| [CJPais/OpenFlow](https://github.com/avijeett007/openflow) | MIT | Treating "no audio captured" as a normal state rather than an error, which shaped our `no_audio` handling. |
| [human37/open-wispr](https://github.com/human37/open-wispr) | MIT | Freshness windows for dictation retrieval. |
| [RogerFilomeno/whisper-typing](https://github.com/rpfilomeno/whisper-typing) | MIT | Length limits before typing into another app. |
| [Prasanjit/whishpy](https://github.com/prasanjit101/whishpy) | MIT | Keeping the connector read-only and never mutating the source database. |
| [tambourine-voice](https://github.com/kstonekuan/tambourine-voice) | **AGPL-3.0** | Read for the trust/onboarding question only. No code copied. |
| [betterwispr](https://github.com/opennookorg/betterwispr) | Apache-2.0 | Read for vocabulary/dictionary handling ideas. No code copied. |
| [murmur](https://github.com/FujiwaraChoki/murmur) | MIT | Read for latency reporting ideas. No code copied. |

Repository names above are the `fullName` values recorded in `.research/seed_repos.md`
during the sweep, so each URL is the repository the finding actually came from. Licence
texts were read from each clone's own `LICENSE` file in `.research/clones/`, not guessed.

## Copyleft statement

Four consulted projects are copyleft (VoiceInk GPL-3.0; SayIt and tambourine-voice
AGPL-3.0; the remainder permissive). Because none of their code is present, FlowMesh
remains MIT and carries no copyleft obligation. If you believe a fragment did make it
across, open an issue — the comparison above is reproducible from `.research/snippets/`.

## What is entirely ours

The bounded plan format, the one-use expiring approval token, the `verified` / `sent` /
`not_configured` receipt vocabulary, the provenance line, the three-runtime parity
fixtures, and the refusal to display a success that was not observed.
