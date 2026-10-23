'use strict';
/**
 * The wake-word listener script and constants. GENERATED from wake.py by
 * scripts/export_agents_catalog.py; do not edit by hand (tests/test_agents_parity.py
 * fails when this file is stale).
 */

const SCRIPT = "$ErrorActionPreference = 'Stop'\ntry {\n  Add-Type -AssemblyName System.Speech\n  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine\n  $choices = New-Object System.Speech.Recognition.Choices\n  foreach ($p in @('hey flow mesh', 'hey flowmesh', 'okay flow mesh')) { [void]$choices.Add($p) }\n  $wake = New-Object System.Speech.Recognition.Grammar((New-Object System.Speech.Recognition.GrammarBuilder($choices)))\n  $wake.Name = 'wake'\n  $engine.LoadGrammar($wake)\n  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))\n  $engine.SetInputToDefaultAudioDevice()\n  [Console]::Out.WriteLine('READY')\n  [Console]::Out.Flush()\n  while ($true) {\n    $r = $engine.Recognize([TimeSpan]::FromSeconds(5))\n    if ($r -ne $null -and $r.Grammar.Name -eq 'wake' -and $r.Confidence -ge 0.82) {\n      [Console]::Out.WriteLine('WAKE ' + [math]::Round($r.Confidence, 2))\n      [Console]::Out.Flush()\n    }\n  }\n} catch {\n  [Console]::Out.WriteLine('ERROR ' + $_.Exception.Message)\n  [Console]::Out.Flush()\n}\n";

const WAKE_PHRASES = ["hey flow mesh", "hey flowmesh", "okay flow mesh"];

const CONFIDENCE_FLOOR = 0.82;

module.exports = { SCRIPT, WAKE_PHRASES, CONFIDENCE_FLOOR };
