---
description: "Autonomous hill-climb: /climb:climb <intent> starts a goal · /climb:climb shows progress · pause · resume · done [goal] · judge [goal] · panel · export [path] · move <path>"
argument-hint: "<intent> [--beat 30m] [--poke-max 3] | pause | resume | done [goal] | panel | move <path>"
disable-model-invocation: true
---

The climb plugin has already run `/climb:climb $ARGUMENTS`; its answer is in the climb context of this message. Act on it: when it started a goal, begin the research it describes. Work through the climb tools (climb_probe, climb_scorecard, climb_experiment, climb_measure, ...), call them directly, and never edit `.climb/`. If no climb context came with this message, say the plugin did not answer and stop.
