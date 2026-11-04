# Heavy-job gate in the dispatch hook (2026-11-04)

The Claude PreToolUse surface (`--rewrite`) applies a second rewrite after RTK: a Bash command whose
stage starts with a heavy launcher (`mlx_audio`, `mlx_lm`, `mlx_whisper`, `whisper`, `faster-whisper`,
`ffmpeg`, `hyperframes render`, `remotion render`, `utmctl start`, or `python -m` of the MLX modules)
is wrapped as `<workspace>/bin/myos-heavy run --class <cls> -- <command>` so it takes a lease from the
machine-wide admission gate (workspace `ops/HEAVY-JOBS.md`). Leading env assignments, `nohup`, `nice`,
`time`, `caffeinate`, `sudo -u` and `xargs` prefixes are recognised; `&&` chains wrap only the heavy
stage; pipelines and `;` chains get a context nudge instead of a rewrite.

A heavy launcher run in the background (`nohup ... &`, `... & done`, `xargs -P`, `parallel`, a `for`
loop) is blocked with the fix in the reason. That exact pattern hung the Mac Studio on 2026-11-04.

Nothing happens when the gate binary is missing (`MYOS_HEAVY_BIN` or `$MYOS_WORKSPACE/bin/myos-heavy`),
when the command already mentions `myos-heavy`, or on the Codex surface (no rewrite ownership there).
Tests: the heavy-job section of `test/myos-dispatch-native-hook.test.js`.
