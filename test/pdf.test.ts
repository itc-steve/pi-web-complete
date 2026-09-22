/**
 * Self-check: PDF text extraction (pdf-parse v2).
 *
 * Run:  npx tsx test/pdf.test.ts
 */

import assert from "node:assert/strict";
import { extractPdfText } from "../src/read/pdf.js";

// Minimal valid single-page PDF containing `text` (ASCII-only, so
// string length === byte length).
function makePdf(text: string): Uint8Array {
	const stream = `BT /F1 24 Tf 72 712 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const xrefPos = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += String(off).padStart(10, "0") + " 00000 n \n";
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
	return new TextEncoder().encode(pdf);
}

const hello = await extractPdfText(makePdf("Hello"));
assert.ok(
	hello.includes("Hello"),
	`expected extracted text to include "Hello", got ${JSON.stringify(hello)}`,
);

// Empty bytes → ""
assert.equal(await extractPdfText(new Uint8Array(0)), "");

// Garbage bytes → "" (never throws)
assert.equal(await extractPdfText(new TextEncoder().encode("not a pdf")), "");

console.log("pdf.test.ts PASS");
