import * as path from 'path';
import { workspace, window, languages, commands, ExtensionContext, TextDocument } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

// Riga tipica di un part-program Z32 (manuale M96)
const rigaGcode = /^\s*(N\d|G\d|M\d|!|--\s*(IF|DO|LOOP|DEFINE)\b|:(OS|TL|PA)\b|%)/i;

// File senza estensione dentro una cartella CMOS configurata (o sottocartella) oppure con contenuto GCODE
function isGcode(doc: TextDocument): boolean {
	if (doc.languageId !== 'plaintext' || doc.uri.scheme !== 'file' || path.extname(doc.fileName) !== '') {
		return false;
	}
	const config = workspace.getConfiguration('gcodeDelectron');
	const file = path.resolve(doc.fileName).toLowerCase();
	if (config.get<string[]>('cartelleCMOS', []).some(c => file.startsWith(path.resolve(c).toLowerCase() + path.sep))) {
		return true;
	}
	if (!config.get<boolean>('riconoscimentoContenuto', true)) {
		return false;
	}
	let righe = 0;
	for (let i = 0; i < Math.min(doc.lineCount, 50) && righe < 3; i++) {
		if (rigaGcode.test(doc.lineAt(i).text)) {
			righe++;
		}
	}
	return righe >= 3;
}

function verifica(doc: TextDocument) {
	if (isGcode(doc)) {
		languages.setTextDocumentLanguage(doc, 'gcode');
	}
}

export function activate(context: ExtensionContext) {
	workspace.textDocuments.forEach(verifica);
	context.subscriptions.push(
		workspace.onDidOpenTextDocument(verifica),
		commands.registerCommand('gcodeDelectron.impostaGcode', () => {
			if (window.activeTextEditor) {
				languages.setTextDocumentLanguage(window.activeTextEditor.document, 'gcode');
			}
		})
	);

	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] }
		}
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'gcode' }]
	};

	client = new LanguageClient('languageServergcode', 'Language Server GCODE', serverOptions, clientOptions);
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	return client ? client.stop() : undefined;
}
