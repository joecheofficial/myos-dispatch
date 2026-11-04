# Heavy-job gate in the dispatch hook (2026-11-04)

The Claude PreToolUse surface (`--rewrite`) applies a second rewrite after RTK: a Bash command whose
stage starts with a heavy launcher (`mlx_audio`, `mlx_lm`, `mlx_whisper`, `whisper`, `faster-whisper`,
`ffmpeg`, `hyperframes render`, `remotion render`, `utmctl start`, or `python -m` of the MLX modules)
is wrapped as `<workspace>/bin/myos-heavy run --class <cls> -- <command>` so it takes a lease from the
machine-wide admission gate (workspace `ops/HEAVY-JOBS.md`). Stages are split at `&&`, `||`, `|`, `;`,
`&` and newlines outside quotes and each heavy stage is wrapped in place, so loops, `nohup ... &`,
`xargs -P` and pipelines keep their shape. Leading env assignments, `nohup`, `nice`, `time`,
`caffeinate`, `sudo -u` and `xargs` prefixes stay in front of the wrapper.

Nothing is ever blocked and nobody has to think about it (Joe, 2026-11-04): a fan-out that used to hang
the Studio now becomes N queued gate calls that run as memory and slots allow.

Nothing happens when the gate binary is missing (`MYOS_HEAVY_BIN` or `$MYOS_WORKSPACE/bin/myos-heavy`),
when the command already mentions `myos-heavy`, or on the Codex surface (no rewrite ownership there).
Tests: the heavy-job section of `test/myos-dispatch-native-hook.test.js`.
