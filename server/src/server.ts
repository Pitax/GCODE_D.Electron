import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	CompletionItem,
	CompletionItemKind,
	Hover,
	MarkupKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => ({
	capabilities: {
		textDocumentSync: TextDocumentSyncKind.Incremental,
		completionProvider: { resolveProvider: true },
		hoverProvider: true
	}
}));

// ============================================================================
// DIZIONARIO: server/data/gcode.json (stesso formato di ML Edit)
// Unica fonte per completamento e hover.
// ============================================================================

interface Voce {
	nomi: string[];        // il primo e' il nome principale, gli altri alias (es. G0 / G00)
	gruppo?: string;       // riga mostrata nel completamento
	kind?: string;         // nome di CompletionItemKind (Function, Keyword, ...)
	sintassi?: string;     // es. "G4 TT secondi"
	descrizione?: string;  // una riga, testo dell'hover
	obsoleta?: boolean;    // esclusa dal completamento, avviso nella diagnostica
}

const DATA_FILE = path.join(__dirname, '..', 'data', 'gcode.json');
const perNome: Map<string, Voce> = new Map();
const completamento: CompletionItem[] = [];

function caricaDizionario(): void {
	let voci: Voce[] = [];
	try {
		voci = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).voci || [];
	} catch (e) {
		connection.console.error(`GCODE: impossibile leggere ${DATA_FILE}: ${(e as Error).message}`);
	}
	for (const v of voci) {
		v.nomi.forEach(n => perNome.set(n.toUpperCase(), v));
		// '--...' e ':...' solo hover: per inserirli si usano gli snippet
		if (!v.obsoleta && !/^(--|:)/.test(v.nomi[0])) {
			completamento.push({
				label: v.nomi[0],
				kind: (CompletionItemKind as unknown as { [k: string]: CompletionItemKind })[v.kind || 'Function'],
				detail: v.gruppo,
				data: v.nomi[0].toUpperCase()
			});
		}
	}
}

/** Testo semplice -> markdown con escape dei caratteri speciali. */
function md(text: string): string {
	return text.replace(/([\\`*_{}[\]<>#|])/g, '\\$1');
}

// Hover / documentazione: nome, sintassi, descrizione
function documentazione(v: Voce): string {
	const righe: string[] = [`**${md(v.nomi[0])}**`];
	if (v.obsoleta) { righe.push('*Obsoleta*'); }
	if (v.sintassi) { righe.push('`' + v.sintassi + '`'); }
	if (v.descrizione) { righe.push(md(v.descrizione)); }
	return righe.join('\n\n');
}

// Parole riconosciute nella riga: istruzioni '--', comandi ':', funzioni G, salti GO.., nomi
const PAROLA = /--\s*(?:END\s*IF|END\s*DEFINE|EXIT\s+DO|ELSE\s*IF|[A-Z]+)|:[A-Z]+|G\s*\d+(?:\.\d+)?|GO\s*(?:DNC|N|P|S)?|[A-Z]+/gi;

// Sostituisce i commenti con spazi (posizioni invariate): ';' a inizio riga o in riga '--',
// '( )' solo in riga ISO (dopo '!' o dentro '< >' le parentesi sono matematiche)
function mascheraCommenti(riga: string): string {
	const strutturata = /^\s*--/.test(riga);
	let out = '', evoluta = false, espressione = false, commento = false;
	for (const ch of riga) {
		if (commento) { out += ' '; commento = ch !== ')'; continue; }
		if (ch === ';' && (strutturata || out.trim() === '')) { return out.padEnd(riga.length); }
		if (ch === '(' && !strutturata && !evoluta && !espressione) { out += ' '; commento = true; continue; }
		evoluta = evoluta || ch === '!';
		espressione = ch === '<' ? true : ch === '>' ? false : espressione;
		out += ch;
	}
	return out;
}

function chiave(parola: string): string {
	const p = parola.toUpperCase().replace(/\s+/g, '');
	const g = /^G(\d+(?:\.\d+)?)$/.exec(p);
	return g ? 'G' + parseFloat(g[1]) : p;   // G00 -> G0, G04 -> G4
}

// ============================================================================
// CONTROLLO ERRORI (passo 4)
// ============================================================================

// Apertura/chiusura dei blocchi strutturati (M96 p.353-368)
const STRUTTURA = /^\s*--\s*(ELSE\s*IF|END\s*IF|EXIT\s+DO|END\s*DEFINE|IF|ELSE|DO|LOOP|DEFINE)\b/i;
const CHIUSURA: { [k: string]: string } = { ENDIF: 'IF', LOOP: 'DO', ENDDEFINE: 'DEFINE' };
const CHIUSURA_DI: { [k: string]: string } = { IF: '--END IF', DO: '--LOOP', DEFINE: '--END DEFINE' };

function valida(doc: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const segnala = (riga: number, inizio: number, fine: number, message: string, severity: DiagnosticSeverity) =>
		diagnostics.push({ severity, range: { start: { line: riga, character: inizio }, end: { line: riga, character: fine } }, message, source: 'GCODE' });

	const righe = doc.getText().split(/\r?\n/).map(r => mascheraCommenti(r).replace(/"[^"]*"?/g, s => ' '.repeat(s.length)));
	// il titolo prima di '%' non e' codice
	const primaRiga = righe.findIndex(r => /^\s*%/.test(r)) + 1;

	// etichette: numeri di riga N (anche /N, //N, %N) e --LN, confronto letterale come il CNC (M96 p.21)
	const etichette = new Set<string>();
	righe.forEach(r => {
		const n = /^\s*(%?\/{0,2}N\s*\d+(?:[.,]\d+)?)/i.exec(r);
		if (n) { etichette.add(n[1].toUpperCase()); }
		const ln = /^\s*--\s*LN\s+(\S+)/i.exec(r);
		if (ln) { etichette.add('LN ' + ln[1].toUpperCase()); }
	});

	const pila: { tipo: string; riga: number }[] = [];
	for (let i = primaRiga; i < righe.length; i++) {
		const r = righe[i];

		// 1. blocchi strutturati
		const s = STRUTTURA.exec(r);
		if (s) {
			const k = s[1].toUpperCase().replace(/\s+/g, '');
			const fine = s.index + s[0].length;
			if (k === 'IF' || k === 'DO' || k === 'DEFINE') {
				pila.push({ tipo: k, riga: i });
			} else if (k === 'ELSEIF' || k === 'ELSE') {
				if (!pila.length || pila[pila.length - 1].tipo !== 'IF') { segnala(i, 0, fine, `--${k} senza --IF`, DiagnosticSeverity.Error); }
			} else if (k === 'EXITDO') {
				if (!pila.some(p => p.tipo === 'DO')) { segnala(i, 0, fine, '--EXIT DO fuori da --DO', DiagnosticSeverity.Error); }
			} else if (pila.length && pila[pila.length - 1].tipo === CHIUSURA[k]) {
				pila.pop();
			} else {
				segnala(i, 0, fine, `${s[0].trim()} senza --${CHIUSURA[k]}`, DiagnosticSeverity.Error);
			}
		}

		// 2. parentesi: '(' commento non chiuso (mascherato fino a fine riga), '[ ]' ovunque, '< >' solo in riga ISO
		const orig = doc.getText({ start: { line: i, character: 0 }, end: { line: i, character: r.length } });
		const aperta = orig.lastIndexOf('(');
		if (aperta >= 0 && r[aperta] === ' ' && !orig.includes(')', aperta)) {
			segnala(i, aperta, r.length, 'Commento "(" non chiuso', DiagnosticSeverity.Error);
		}
		const iso = s ? '' : r.split('!')[0];
		for (const [a, c, testo] of [['[', ']', r], ['<', '>', iso]]) {
			let livello = 0;
			for (let j = 0; j < testo.length && livello >= 0; j++) {
				livello += testo[j] === a ? 1 : testo[j] === c ? -1 : 0;
				if (livello < 0) { segnala(i, j, j + 1, `"${c}" senza "${a}"`, DiagnosticSeverity.Error); }
			}
			if (livello > 0) { segnala(i, testo.lastIndexOf(a), testo.length, `"${a}" non chiusa`, DiagnosticSeverity.Error); }
		}

		// 3. salti a etichette inesistenti: !GON n!, !GON n1-N n2!, --GOTO LN x (non parametrici)
		const salti = /(?<=[!;])\s*GO\s*(%?\/{0,2}N[^!;<]*)(?=[!;])|^\s*--\s*GOTO\s+(LN)\s+([^\s<]+)/gi;
		let m: RegExpExecArray | null;
		while ((m = salti.exec(r))) {
			const destinazioni = m[1] ? m[1].split(/-(?=\s*%?\/{0,2}N)/) : [m[2] + ' ' + m[3]];
			for (const d of destinazioni.map(x => x.trim().toUpperCase())) {
				if (!etichette.has(d)) {
					const pos = r.indexOf(d.split(' ').pop() as string, m.index);
					segnala(i, pos, pos + d.length, `Salto a ${d} inesistente nel file`, DiagnosticSeverity.Warning);
				}
			}
		}

		// 4. funzioni G sconosciute / obsolete (G880-G999: cicli da disco, sempre valide)
		const g = /(?<![A-Z])G\s*(\d+(?:\.\d+)?)/gi;
		while ((m = g.exec(r))) {
			const num = parseFloat(m[1]);
			const v = perNome.get('G' + num);
			if (num >= 880 && num <= 999) { continue; }
			if (!v) {
				segnala(i, m.index, m.index + m[0].length, `G${num} sconosciuta`, DiagnosticSeverity.Warning);
			} else if (v.obsoleta) {
				segnala(i, m.index, m.index + m[0].length, `G${num} obsoleta`, DiagnosticSeverity.Warning);
			}
		}
	}
	pila.forEach(p => segnala(p.riga, 0, righe[p.riga].length, `--${p.tipo} senza ${CHIUSURA_DI[p.tipo]}`, DiagnosticSeverity.Error));
	return diagnostics;
}

documents.onDidChangeContent(change => {
	connection.sendDiagnostics({ uri: change.document.uri, diagnostics: valida(change.document) });
});

// ============================================================================
// COMPLETAMENTO: elenco dal dizionario, documentazione su "resolve"
// ============================================================================

connection.onCompletion((): CompletionItem[] => completamento);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	const v = perNome.get(String(item.data));
	if (v) {
		item.documentation = { kind: MarkupKind.Markdown, value: documentazione(v) };
	}
	return item;
});

// ============================================================================
// HOVER
// ============================================================================

connection.onHover((pos: TextDocumentPositionParams): Hover | undefined => {
	const document = documents.get(pos.textDocument.uri);
	if (!document) { return undefined; }
	const riga = mascheraCommenti(document.getText({ start: { line: pos.position.line, character: 0 }, end: { line: pos.position.line + 1, character: 0 } }));
	let m: RegExpExecArray | null;
	PAROLA.lastIndex = 0;
	while ((m = PAROLA.exec(riga))) {
		if (pos.position.character >= m.index && pos.position.character < m.index + m[0].length) {
			const v = perNome.get(chiave(m[0]));
			return v ? { contents: { kind: MarkupKind.Markdown, value: documentazione(v) } } : undefined;
		}
	}
	return undefined;
});

caricaDizionario();
documents.listen(connection);
connection.listen();
