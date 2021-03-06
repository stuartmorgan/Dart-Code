import * as editors from "../editors";
import * as vs from "vscode";
import * as as from "../analysis/analysis_server_types";
import { Analyzer } from "../analysis/analyzer";
import { toRange, fsPath } from "../utils";

export class TypeHierarchyCommand implements vs.Disposable {
	private analyzer: Analyzer;
	private disposables: vs.Disposable[] = [];

	constructor(analyzer: Analyzer) {
		this.analyzer = analyzer;

		this.disposables.push(
			vs.commands.registerCommand("dart.showTypeHierarchy", this.showTypeHierarchy, this),
		);
	}

	private async showTypeHierarchy(): Promise<void> {
		if (!editors.hasActiveDartEditor()) {
			vs.window.showWarningMessage("No active Dart editor.");
			return;
		}

		const editor = vs.window.activeTextEditor;
		const document = editor.document;

		const response = await this.analyzer.searchGetTypeHierarchy({
			file: fsPath(document.uri),
			offset: document.offsetAt(editor.selection.active),
		});

		const items = response.hierarchyItems;
		if (!items) {
			vs.window.showInformationMessage("Type hierarchy not available.");
			return;
		}

		const options = { placeHolder: name(items, 0) };

		// TODO: How / where to show implements?
		const tree = [];
		const startItem = items[0];

		tree.push(startItem);
		addParents(items, tree, startItem);
		addChildren(items, tree, startItem);

		const result = await vs.window.showQuickPick(tree.map((item) => itemToPick(item, items)), options);
		if (result) {
			// TODO: extract out so we have one way of jumping to code
			// Currently we have Type Hierarchy, Go To Super, Flutter Outline
			const location: as.Location = result.location;
			const document = await vs.workspace.openTextDocument(location.file);
			const editor = await vs.window.showTextDocument(document);
			const range = toRange(location);
			editor.revealRange(range, vs.TextEditorRevealType.InCenterIfOutsideViewport);
			editor.selection = new vs.Selection(range.end, range.start);
		}
	}

	public dispose(): any {
		this.disposables.forEach((d) => d.dispose());
	}
}

function addParents(items: as.TypeHierarchyItem[], tree: as.TypeHierarchyItem[], item: as.TypeHierarchyItem) {
	if (item.superclass) {
		const parent = items[item.superclass];

		if (parent.classElement.name !== "Object") {
			tree.unshift(parent);
			addParents(items, tree, parent);
		}
	}
}

function addChildren(items: as.TypeHierarchyItem[], tree: as.TypeHierarchyItem[], item: as.TypeHierarchyItem) {
	// Handle direct children.
	for (const index of item.subclasses) {
		const child = items[index];
		tree.push(child);
	}

	// Handle grandchildren.
	for (const index of item.subclasses) {
		const child = items[index];
		if (child.subclasses.length > 0)
			addChildren(items, tree, child);
	}
}

function itemToPick(item: as.TypeHierarchyItem, items: as.TypeHierarchyItem[]): vs.QuickPickItem & { location?: as.Location } {
	let desc = "";

	// extends
	if (item.superclass !== undefined && name(items, item.superclass) !== "Object")
		desc += `extends ${name(items, item.superclass)}`;

	// implements
	if (item.interfaces.length > 0) {
		if (desc.length > 0)
			desc += ", ";
		desc += `implements ${item.interfaces.map((i) => name(items, i)).join(", ")}`;
	}

	// with
	if (item.mixins.length > 0) {
		if (desc.length > 0)
			desc += ", ";
		desc += `with ${item.mixins.map((i) => name(items, i)).join(", ")}`;
	}

	const result = {
		description: desc,
		label: item.classElement.name,
		location: item.classElement.location,
	};

	return result;
}

function name(items: as.TypeHierarchyItem[], index: number) {
	return items[index].classElement.name;
}
