**Subject**: Right `CLAUDE_CODE_ENTRYPOINT` value for third-party IDE-style hosts

Hi —

I maintain Harness (https://github.com/frenchie4111/harness), a desktop app
that surfaces Claude Code in a native chat-panel UI alongside terminal
sessions. Internally we spawn the bundled `@anthropic-ai/claude-code` binary
with `-p --input-format=stream-json --output-format=stream-json
--permission-prompt-tool …` — functionally identical to how Anthropic's own
VS Code extension drives the binary, just hosted in a different app.

With the Agent SDK billing changes effective June 15, 2026 (article 15036540),
I want to make sure Harness users on Claude Pro/Max/Team plans stay on their
interactive subscription limits — the same treatment users get when they use
the official VS Code extension's chat panel — rather than being routed to the
new SDK credit bucket.

Reading the bundled binary, the `UM()` check keys interactive-vs-SDK
classification off the `CLAUDE_CODE_ENTRYPOINT` env var (returns true when
the value is not in {`sdk-ts`, `sdk-py`, `sdk-cli`, `local-agent`}). The
official VS Code extension sets it to `claude-vscode`. Harness, until today,
didn't set it at all, so claude-code's autodetect was tagging us as SDK.

Two questions:

1. Is it appropriate for Harness to set `CLAUDE_CODE_ENTRYPOINT=claude-vscode`,
   or would you prefer we set a host-specific value like `claude-harness`?
2. If we should use our own identifier, can we get one registered on
   Anthropic's side so the billing system routes us into the interactive
   bucket the same way it does for the IDE plugins?

Happy to share the source diff or any additional context.

Thanks,
Mike
