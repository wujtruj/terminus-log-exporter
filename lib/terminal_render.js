'use strict';
// Minimal line-oriented terminal emulator for rendering libtermius LogReader
// output to plain text. Handles the CSI/CR/BS/OSC sequences that shells emit
// during line editing, autocomplete, and history navigation; drops SGR and
// other display-only escapes. Not a full VT100 — no scrollback, no row
// addressing; cursor moves act within the current line only.

function renderTerminalStream(buf) {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    const out = [];
    let line = [];
    let cursor = 0;

    const flushLine = () => {
        out.push(line.join(''));
        line = [];
        cursor = 0;
    };

    const writeChar = (ch) => {
        if (cursor < line.length) {
            line[cursor] = ch;
        } else {
            while (line.length < cursor) line.push(' ');
            line.push(ch);
        }
        cursor++;
    };

    const n = text.length;
    let i = 0;
    while (i < n) {
        const ch = text[i];
        const code = text.charCodeAt(i);

        if (ch === '\n') {
            flushLine();
            out.push('\n');
            i++;
            continue;
        }
        if (ch === '\r') {
            cursor = 0;
            i++;
            continue;
        }
        if (code === 0x08) { // BS
            if (cursor > 0) cursor--;
            i++;
            continue;
        }
        if (code === 0x1B) { // ESC
            if (i + 1 >= n) { i = n; break; }
            const next = text[i + 1];
            if (next === '[') {
                // CSI: optional private marker, params, intermediates, final byte
                let j = i + 2;
                let priv = '';
                if (j < n && (text[j] === '?' || text[j] === '<' || text[j] === '>' || text[j] === '=')) {
                    priv = text[j];
                    j++;
                }
                let paramStart = j;
                while (j < n) {
                    const c = text.charCodeAt(j);
                    if ((c >= 0x30 && c <= 0x39) || c === 0x3B) j++; // 0-9 ;
                    else break;
                }
                const params = text.slice(paramStart, j);
                while (j < n) {
                    const c = text.charCodeAt(j);
                    if (c >= 0x20 && c <= 0x2F) j++; // intermediates
                    else break;
                }
                if (j >= n) { i = n; break; }
                const final = text[j];
                const finalCode = text.charCodeAt(j);
                j++;
                if (priv === '' && finalCode >= 0x40 && finalCode <= 0x7E) {
                    const args = params === '' ? [] : params.split(';').map(s => s === '' ? null : parseInt(s, 10));
                    const arg0 = args[0];
                    switch (final) {
                        case 'K': {
                            const mode = arg0 == null ? 0 : arg0;
                            if (mode === 0) {
                                if (cursor < line.length) line.length = cursor;
                            } else if (mode === 1) {
                                const end = Math.min(cursor + 1, line.length);
                                for (let k = 0; k < end; k++) line[k] = ' ';
                            } else if (mode === 2) {
                                line = [];
                            }
                            break;
                        }
                        case 'D': {
                            const nn = arg0 == null || arg0 === 0 ? 1 : arg0;
                            cursor = Math.max(0, cursor - nn);
                            break;
                        }
                        case 'C': {
                            const nn = arg0 == null || arg0 === 0 ? 1 : arg0;
                            cursor = cursor + nn;
                            break;
                        }
                        case 'G': {
                            const col = (arg0 == null ? 1 : arg0) - 1;
                            cursor = Math.max(0, col);
                            break;
                        }
                        case 'H':
                        case 'f': {
                            const col = (args[1] == null ? 1 : args[1]) - 1;
                            cursor = Math.max(0, col);
                            break;
                        }
                        // SGR ('m'), CUU ('A'), CUD ('B'), DSR ('n'), and anything else: ignore
                        default:
                            break;
                    }
                }
                // private-mode CSI (DEC ?, etc.): consumed silently
                i = j;
                continue;
            }
            if (next === ']') {
                // OSC: terminated by BEL (0x07) or ST (ESC \)
                let j = i + 2;
                while (j < n) {
                    if (text.charCodeAt(j) === 0x07) { j++; break; }
                    if (text[j] === '\x1B' && j + 1 < n && text[j + 1] === '\\') { j += 2; break; }
                    j++;
                }
                i = j;
                continue;
            }
            // Other ESC X — consume the dispatch byte
            i += 2;
            continue;
        }
        if (code < 0x20) {
            // Drop other C0 control bytes (BEL, HT, VT, FF, etc.).
            // HT could be expanded to spaces; not implemented because Termius
            // sessions almost never emit raw TAB in rendered output.
            i++;
            continue;
        }
        // Printable. UTF-8 already decoded to JS code units; combine surrogate pairs.
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < n) {
            writeChar(text[i] + text[i + 1]);
            i += 2;
        } else {
            writeChar(ch);
            i++;
        }
    }

    if (line.length > 0) {
        out.push(line.join(''));
    }

    return out.join('');
}

module.exports = { renderTerminalStream };
