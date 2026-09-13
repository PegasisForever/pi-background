import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

/** What a tool tells the TUI and never tells the model. */
export interface Shown {
	lines: string[];
	/** The first line is a table heading, so it is dimmed rather than read as data. */
	heading?: boolean;
}

const fill = (box: Box, theme: Theme, colour: "customMessageText" | "toolOutput", shown: Shown) => {
	shown.lines.forEach((line, i) => {
		box.addChild(new Text(theme.fg(shown.heading && i === 0 ? "muted" : colour, line), 0, 0));
	});
	return box;
};

/** A block of our own: pi does not wrap a custom renderer, so it pads and tints itself. */
export const block = (theme: Theme, shown: Shown): Component =>
	fill(new Box(1, 1, (t: string) => theme.bg("customMessageBg", t)), theme, "customMessageText", shown);

/** Lines inside pi's tool shell, which already pads. A second Box would indent them again. */
export const rows = (theme: Theme, shown: Shown): Component =>
	fill(new Box(0, 0), theme, "toolOutput", shown);

/** The first row of a tool: its name in bold, then whatever names this particular call. */
export const header = (theme: Theme, name: string, title?: string): Component =>
	new Text(theme.fg("toolTitle", theme.bold(name)) + (title ? ` ${title}` : ""), 0, 0);

/** The rows of a tool result, taken from the half of it the model never sees. */
export const shown = (result: { details?: Shown }, theme: Theme): Component =>
	rows(theme, result.details ?? { lines: [] });

/** A message this extension injected, labelled so you can tell it from the model's own text. */
export const labelled = (theme: Theme, name: string, lines: string[]): Component => {
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${name}]`)), 0, 0));
	box.addChild(new Spacer(1));
	for (const line of lines) box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
	return box;
};
