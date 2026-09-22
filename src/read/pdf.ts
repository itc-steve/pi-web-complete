import { PDFParse } from "pdf-parse";

/**
 * Extract text from a PDF byte buffer.
 * Invalid/empty input → `""` (never throws). No images, no tables, no OCR.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
	if (data.length === 0) return "";
	try {
		const parser = new PDFParse({ data });
		try {
			const result = await parser.getText();
			return result.text.trim();
		} finally {
			await parser.destroy();
		}
	} catch {
		return "";
	}
}
