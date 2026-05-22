import type { AppState } from "../shared/state";
import { initialBrowser } from "../shared/state/browser";
import { initialCosts } from "../shared/state/costs";
import { initialHooks } from "../shared/state/hooks";
import { initialJsonClaude } from "../shared/state/json-claude";
import { initialOnboarding } from "../shared/state/onboarding";
import { initialPRs } from "../shared/state/prs";
import { initialRepoConfigs } from "../shared/state/repo-configs";
import { initialSettings } from "../shared/state/settings";
import { initialSnooze } from "../shared/state/snooze";
import { initialTerminals } from "../shared/state/terminals";
import { initialUpdater } from "../shared/state/updater";
import { initialWorktrees } from "../shared/state/worktrees";
import { DEFAULT_EDITOR_ID } from "./editor";
import {
	type Config,
	DEFAULT_CLAUDE_COMMAND,
	DEFAULT_HARNESS_SYSTEM_PROMPT,
	DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
	DEFAULT_MERGE_STRATEGY,
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	DEFAULT_WORKTREE_BASE,
} from "./persistence";

export function buildInitialAppState(
	config: Config,
	opts: { hasGithubToken: boolean },
): AppState {
	return {
		prs: initialPRs,
		onboarding: {
			...initialOnboarding,
			quest: config.onboarding?.quest ?? "hidden",
		},
		hooks: initialHooks,
		worktrees: { ...initialWorktrees, repoRoots: config.repoRoots || [] },
		terminals: initialTerminals,
		updater: initialUpdater,
		repoConfigs: initialRepoConfigs,
		costs: config.costs ? { ...initialCosts, ...config.costs } : initialCosts,
		browser: initialBrowser,
		jsonClaude: initialJsonClaude,
		snooze: config.snooze ? { byPath: { ...config.snooze } } : initialSnooze,
		settings: {
			...initialSettings,
			themeMode:
				config.themeMode === "light" || config.themeMode === "dark"
					? config.themeMode
					: "system",
			themeLight: config.themeLight || "solarized-light",
			themeDark: config.themeDark || "dark",
			hotkeys: config.hotkeys || null,
			defaultAgent: config.defaultAgent || "claude",
			claudeCommand: config.claudeCommand || DEFAULT_CLAUDE_COMMAND,
			codexCommand: config.codexCommand || "codex",
			worktreeScripts: {
				setup: config.worktreeSetupCommand || "",
				teardown: config.worktreeTeardownCommand || "",
			},
			claudeEnvVars: config.claudeEnvVars || {},
			codexEnvVars: config.codexEnvVars || {},
			harnessMcpEnabled: config.harnessMcpEnabled !== false,
			nameClaudeSessions: config.nameClaudeSessions ?? false,
			terminalFontFamily:
				config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
			terminalFontSize: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
			editor: config.editor || DEFAULT_EDITOR_ID,
			worktreeBase: config.worktreeBase || DEFAULT_WORKTREE_BASE,
			mergeStrategy: config.mergeStrategy || DEFAULT_MERGE_STRATEGY,
			claudeModel: config.claudeModel || null,
			codexModel: config.codexModel || null,
			hasGithubToken: opts.hasGithubToken,
			autoUpdateEnabled: config.autoUpdateEnabled !== false,
			shareClaudeSettings: config.shareClaudeSettings !== false,
			harnessSystemPromptEnabled: config.harnessSystemPromptEnabled !== false,
			harnessSystemPrompt:
				config.harnessSystemPrompt || DEFAULT_HARNESS_SYSTEM_PROMPT,
			harnessSystemPromptMain:
				config.harnessSystemPromptMain || DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
			claudeTuiFullscreen: config.claudeTuiFullscreen !== false,
			wsTransportEnabled: config.wsTransportEnabled === true,
			wsTransportPort: config.wsTransportPort ?? 37291,
			wsTransportHost: config.wsTransportHost ?? "127.0.0.1",
			browserToolsEnabled: config.browserToolsEnabled !== false,
			browserToolsMode: config.browserToolsMode === "view" ? "view" : "full",
			jsonModeClaudeTabs: config.jsonModeClaudeTabs === true,
			defaultClaudeTabType:
				config.defaultClaudeTabType === "json" ? "json" : "xterm",
			autoApprovePermissions: config.autoApprovePermissions === true,
			autoApproveSteerInstructions: config.autoApproveSteerInstructions || "",
			useSystemClaudeForJsonMode: config.useSystemClaudeForJsonMode === true,
			jsonModeChatDensity:
				config.jsonModeChatDensity === "comfy" ? "comfy" : "compact",
			jsonModeDefaultPermissionMode:
				config.jsonModeDefaultPermissionMode === "default" ||
				config.jsonModeDefaultPermissionMode === "plan"
					? config.jsonModeDefaultPermissionMode
					: "acceptEdits",
			autoSleepMinutes:
				typeof config.autoSleepMinutes === "number" &&
				Number.isFinite(config.autoSleepMinutes) &&
				config.autoSleepMinutes >= 0
					? Math.floor(config.autoSleepMinutes)
					: 30,
			snoozeDefaultDays: Math.max(1, Math.floor(config.snoozeDefaultDays ?? 7)),
		},
	};
}
