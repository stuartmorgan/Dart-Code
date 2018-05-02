"use strict";

import * as vs from "vscode";
import * as path from "path";
import * as as from "../analysis/analysis_server_types";
import { Analyzer } from "../analysis/analyzer";
import { isAnalyzable } from "../utils";
import { editor } from "../../test/helpers";
import { flutterOutlineCommands } from "../commands/flutter_outline";
import { extensionPath } from "../extension";

const DART_SHOW_FLUTTER_OUTLINE = "dart-code:showFlutterOutline";
const DART_IS_WIDGET = "dart-code:isWidget";

export class FlutterOutlineProvider implements vs.TreeDataProvider<FlutterWidgetItem>, vs.Disposable {
	private subscriptions: vs.Disposable[] = [];
	private analyzer: Analyzer;
	private activeEditor: vs.TextEditor;
	private flutterOutline: as.FlutterOutlineNotification;
	private treeNodesByLine: { [key: number]: FlutterWidgetItem[]; } = [];
	private updateTimeout: NodeJS.Timer;
	private onDidChangeTreeDataEmitter: vs.EventEmitter<FlutterWidgetItem | undefined> = new vs.EventEmitter<FlutterWidgetItem | undefined>();
	public readonly onDidChangeTreeData: vs.Event<FlutterWidgetItem | undefined> = this.onDidChangeTreeDataEmitter.event;

	constructor(analyzer: Analyzer) {
		this.analyzer = analyzer;
		this.analyzer.registerForFlutterOutline((n) => {
			if (this.activeEditor && n.file === this.activeEditor.document.fileName) {
				this.flutterOutline = n;
				this.treeNodesByLine = [];
				// Delay this so if we're getting lots of updates we don't flicker.
				clearTimeout(this.updateTimeout);
				this.updateTimeout = setTimeout(() => this.update(), 200);
			}
		});

		this.subscriptions.push(vs.window.onDidChangeActiveTextEditor((e) => this.setTrackingFile(e)));
		if (vs.window.activeTextEditor) {
			this.setTrackingFile(vs.window.activeTextEditor);
		}
	}

	private update() {
		FlutterOutlineProvider.showTree();
		this.refresh();
	}

	private setTrackingFile(editor: vs.TextEditor) {
		if (editor && isAnalyzable(editor.document)) {
			this.activeEditor = editor;
			this.flutterOutline = null;
			this.refresh(); // Force update (to nothing) while requests are in-flight.
			this.analyzer.forceNotificationsFor(editor.document.fileName);
		} else if (editor && editor.document.uri.scheme === "file") {
			// HACK: We can't currently reliably tell when editors are changed that are only real
			// text editors (debug window is considered an editor) so we should only hide the tree
			// when we know a file that is not ours is selected.
			// https://github.com/Microsoft/vscode/issues/45188
			this.activeEditor = null;
			FlutterOutlineProvider.hideTree();
		} else {
			// HACK: If there are no valid open editors, hide the tree.
			// The timeout is because the open editors disappear briefly during a closing
			// of one preview and opening of another :(
			// https://github.com/Microsoft/vscode/issues/45188.
			setTimeout(() => {
				if (!vs.window.visibleTextEditors.filter((e) => isAnalyzable(e.document)).length) {
					FlutterOutlineProvider.hideTree();
				}
			}, 100);
		}
	}

	public getNodeAt(pos: vs.Position) {
		if (!this.treeNodesByLine[pos.line])
			return;

		const offset = this.activeEditor.document.offsetAt(pos);
		const nodes = this.treeNodesByLine[pos.line];
		// We want the last node that started before the position (eg. most specific).
		let currentBest = null;
		for (const item of nodes) {
			if (item.outline.offset < offset
				&& item.outline.offset + item.outline.length > offset) {
				currentBest = item;
			}
		}
		return currentBest;
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	public getTreeItem(element: FlutterWidgetItem): vs.TreeItem {
		return element;
	}

	public async getChildren(element?: FlutterWidgetItem): Promise<FlutterWidgetItem[]> {
		const outline = element
			? element.outline
			: (this.flutterOutline ? this.flutterOutline.outline : null);
		const children: FlutterWidgetItem[] = [];
		const editor = this.activeEditor;

		if (outline) {
			if (outline.children && outline.length) {
				for (const c of outline.children) {

					// TODO: We can't use fixes for context menu unless we have a more performant
					// way of getting them.
					// https://github.com/dart-lang/sdk/issues/32462
					const canHaveFixes = false; // isWidget(c);
					const fixes = canHaveFixes
						? await getFixes(editor, c)
						: [];
					// Ensure we're still active editor before trying to use.
					if (editor && editor.document && !editor.document.isClosed && this.activeEditor === editor) {
						const codeActionFixes =
							fixes
								.filter((f): f is vs.CodeAction => f instanceof vs.CodeAction)
								.filter((ca) => ca.kind && ca.kind.value);
						const node = new FlutterWidgetItem(element, c, codeActionFixes, editor);
						children.push(node);
						// Add this node to a lookup by line so we can quickly find it as the user moves around the doc.
						const startLine = editor.document.positionAt(c.offset).line;
						const endLine = editor.document.positionAt(c.offset + c.length).line;
						for (let line = startLine; line <= endLine; line++) {
							if (!this.treeNodesByLine[line]) {
								this.treeNodesByLine[line] = [];
							}
							this.treeNodesByLine[line].push(node);
						}
					}
				}
			}
		}

		return children;
	}

	public getParent(element: FlutterWidgetItem): FlutterWidgetItem {
		return element.parent;
	}

	private static setTreeVisible(visible: boolean) {
		vs.commands.executeCommand("setContext", DART_SHOW_FLUTTER_OUTLINE, visible);
	}

	public static showTree() { this.setTreeVisible(true); }
	public static hideTree() { this.setTreeVisible(false); }

	public dispose() {
		this.activeEditor = null;
		this.subscriptions.forEach((s) => s.dispose());
	}
}

function isWidget(outline: as.FlutterOutline) {
	return outline.kind !== "DART_ELEMENT";
}

function getFixes(editor: vs.TextEditor, outline: as.FlutterOutline): Thenable<Array<vs.Command | vs.CodeAction>> {
	const pos = editor.document.positionAt(outline.offset);
	const range = new vs.Range(pos, pos);
	return vs.commands.executeCommand(
		"vscode.executeCodeActionProvider",
		editor.document.uri,
		range,
	);
}

export class FlutterWidgetItem extends vs.TreeItem {
	constructor(
		public readonly parent: FlutterWidgetItem,
		public readonly outline: as.FlutterOutline,
		public readonly fixes: vs.CodeAction[],
		editor: vs.TextEditor,
	) {
		super(
			FlutterWidgetItem.getLabel(outline),
			(outline.children && outline.children.length)
				? vs.TreeItemCollapsibleState.Expanded
				: vs.TreeItemCollapsibleState.None,
		);

		if (isWidget(outline)) {
			this.iconPath = path.join(extensionPath, "media/icons/flutter.svg");
		}

		this.command = {
			arguments: [
				editor,
				// Code to fit on screen
				new vs.Range(
					editor.document.positionAt(outline.offset),
					editor.document.positionAt(outline.offset + outline.length),
				),
				// Code to highlight
				new vs.Range(
					editor.document.positionAt(outline.codeOffset),
					editor.document.positionAt(outline.codeOffset + outline.codeLength),
				),
				// Selection (we just want to move cursor, so it's 0-length)
				new vs.Range(
					editor.document.positionAt((outline.dartElement ? outline.dartElement.location : outline).offset),
					editor.document.positionAt((outline.dartElement ? outline.dartElement.location : outline).offset),
				),
			],
			command: "_dart.showCode",
			title: "",
		};

		// Create a context value that is each item with a pipe at each side.
		const refactorData = this
			.fixes
			.map((ca) => ca.kind.value)
			.filter((c) => flutterOutlineCommands.indexOf(c) !== -1)
			.join("--");
		if (refactorData) {
			// So we can search by --ID--
			this.contextValue = DART_IS_WIDGET + ":--" + refactorData + "--";
		}

		this.tooltip = this.label;
		if (outline.attributes) {
			this.tooltip += "\n  " + outline.attributes.map((a) => `${a.name}: ${a.label}`).join("\n   ");
		}
	}

	private static getLabel(outline: as.FlutterOutline): string {
		let label = "";

		if (outline.dartElement) {
			label += " " + outline.dartElement.name;
			if (outline.dartElement.typeParameters)
				label += outline.dartElement.typeParameters;
			if (outline.dartElement.parameters)
				label += outline.dartElement.parameters;
			if (outline.dartElement.returnType)
				label += " → " + outline.dartElement.returnType;
		}

		if (outline.variableName)
			label += " " + outline.variableName;

		if (outline.className)
			label += " " + outline.className;

		if (outline.label)
			label += " " + outline.label;

		return label.trim();
	}
}
