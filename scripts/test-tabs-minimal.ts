#!/usr/bin/env bun
/**
 * Minimal reproduction of the tab/space bug in ghostty-opentui
 *
 * Bug: ptyToJson() and getJson() span output strips spaces from tab expansion
 *
 * Run: bun scripts/test-tabs-minimal.ts
 */

import { ptyToJson, ptyToText, PersistentTerminal } from 'ghostty-opentui';

console.log('=== ghostty-opentui Tab Expansion Bug ===\n');

const input = 'a\tb\tc';  // 'a', tab, 'b', tab, 'c'

// Method 1: ptyToText - WORKS
const textOutput = ptyToText(input, { cols: 80, rows: 1 });
console.log('ptyToText():');
console.log(`  Input:  "a\\tb\\tc"`);
console.log(`  Output: "${textOutput}"`);
console.log(`  Length: ${textOutput.length}`);
console.log(`  Spaces: ${(textOutput.match(/ /g) || []).length}`);
console.log();

// Method 2: ptyToJson - BROKEN (spans missing spaces)
const jsonOutput = ptyToJson(input, { cols: 80, rows: 1 });
const spanText = jsonOutput.lines[0]?.spans.map(s => s.text).join('') || '';
console.log('ptyToJson() spans:');
console.log(`  Input:  "a\\tb\\tc"`);
console.log(`  Output: "${spanText}"`);
console.log(`  Length: ${spanText.length}`);
console.log(`  Spaces: ${(spanText.match(/ /g) || []).length}`);
console.log(`  Spans:  ${JSON.stringify(jsonOutput.lines[0]?.spans.map(s => ({ text: s.text, width: s.width })))}`);
console.log();

// Method 3: PersistentTerminal.getText() - WORKS
const term = new PersistentTerminal({ cols: 80, rows: 24 });
term.feed(input);
const termText = term.getText();
console.log('PersistentTerminal.getText():');
console.log(`  Input:  "a\\tb\\tc"`);
console.log(`  Output: "${termText.split('\n')[0]}"`);
console.log(`  Length: ${termText.split('\n')[0].length}`);
console.log();

// Method 4: PersistentTerminal.getJson() - BROKEN (spans missing spaces)
const termJson = term.getJson();
const termSpanText = termJson.lines[0]?.spans.map(s => s.text).join('') || '';
console.log('PersistentTerminal.getJson() spans:');
console.log(`  Input:  "a\\tb\\tc"`);
console.log(`  Output: "${termSpanText}"`);
console.log(`  Length: ${termSpanText.length}`);
console.log(`  Spans:  ${JSON.stringify(termJson.lines[0]?.spans.map(s => ({ text: s.text, width: s.width })))}`);
console.log();

term.destroy();

// Diagnosis
console.log('=== Diagnosis ===');
console.log('The terminal emulator correctly expands tabs to spaces internally.');
console.log('getText() and ptyToText() correctly return the expanded text.');
console.log('However, getJson() and ptyToJson() span extraction SKIPS space cells.');
console.log('');
console.log('This means the TUI Terminal component (which uses spans) shows no spaces!');
console.log('');
console.log('Expected span output: [{ text: "a       ", width: 8 }, { text: "b       ", width: 8 }, { text: "c", width: 1 }]');
console.log('Or:                   [{ text: "a", width: 1 }, { text: "       ", width: 7 }, { text: "b", width: 1 }, ...]');
console.log(`Actual span output:   ${JSON.stringify(jsonOutput.lines[0]?.spans.map(s => ({ text: s.text, width: s.width })))}`);
