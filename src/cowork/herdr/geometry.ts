/**
 * Pane cell grid ⇄ browser pixel geometry.
 *
 * The pane is a character grid; the browser is pixels. Herdr places a graphics
 * layer over a rectangle of cells, so the browser viewport is sized to exactly
 * cols*cellWidth x rows*cellHeight and no scaling correction is needed on the
 * way back. captureScale only shrinks the transferred image, not the viewport,
 * so input mapping stays independent of it.
 */

export interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ViewLayout {
	/** Cell rows reserved for the toolbar at the top of the pane. */
	toolbarRows: number;
	/** Cell rows reserved for the diagnostics line at the bottom. */
	statusRows: number;
	/** Graphics area in cells. */
	gridCols: number;
	gridRows: number;
	/** Graphics origin within the pane viewport, in cells. */
	viewportCol: number;
	viewportRow: number;
	/** Browser viewport in CSS pixels. */
	pageWidth: number;
	pageHeight: number;
	/** Transferred image size (pageW/H * captureScale, min 1px). */
	imageWidth: number;
	imageHeight: number;
}

export interface LayoutInput {
	paneCols: number;
	paneRows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	toolbarRows: number;
	statusRows: number;
	captureScale: number;
}

export function computeLayout(input: LayoutInput): ViewLayout {
	const { paneCols, paneRows, cellWidthPx, cellHeightPx } = input;
	const toolbarRows = Math.max(0, Math.floor(input.toolbarRows));
	const statusRows = Math.max(0, Math.floor(input.statusRows));

	const gridCols = Math.max(1, Math.floor(paneCols));
	const gridRows = Math.max(1, Math.floor(paneRows) - toolbarRows - statusRows);

	const pageWidth = Math.max(1, gridCols * cellWidthPx);
	const pageHeight = Math.max(1, gridRows * cellHeightPx);

	const scale = Math.min(1, Math.max(0.1, input.captureScale));
	return {
		toolbarRows,
		statusRows,
		gridCols,
		gridRows,
		viewportCol: 0,
		viewportRow: toolbarRows,
		pageWidth,
		pageHeight,
		imageWidth: Math.max(1, Math.round(pageWidth * scale)),
		imageHeight: Math.max(1, Math.round(pageHeight * scale)),
	};
}

export function deviceMetricsForLayout(layout: ViewLayout, zoom = 1) {
	// `scale` shrinks page content inside an unchanged width x height frame, which
	// leaves blank margins. Zoom is a CSS-viewport change instead: the viewport is
	// pageSize/zoom CSS px and deviceScaleFactor maps it back onto exactly
	// pageWidth x pageHeight device px, so the frame always fills the pane.
	const z = Math.min(2.5, Math.max(0.5, zoom));
	return {
		width: Math.max(1, Math.round(layout.pageWidth / z)),
		height: Math.max(1, Math.round(layout.pageHeight / z)),
		deviceScaleFactor: z,
		mobile: false,
		scale: 1,
	};
}

/**
 * Terminal cell (1-based, pane-relative) → page pixel.
 * Returns null when the cell is outside the graphics area (toolbar/status rows),
 * so toolbar clicks are never forwarded to the page.
 */
export function cellToPagePixel(
	col: number,
	row: number,
	layout: ViewLayout,
	cell: { cellWidthPx: number; cellHeightPx: number },
	pageZoom = 1,
): { x: number; y: number } | null {
	// 1-based terminal coords → 0-based grid coords.
	const gridCol = col - 1;
	const gridRow = row - 1 - layout.viewportRow;
	if (gridCol < 0 || gridRow < 0) return null;
	if (gridCol >= layout.gridCols || gridRow >= layout.gridRows) return null;

	// CDP input uses CSS pixels. Device-metrics view scaling changes visible
	// pixels, so convert the visible cell centre back to CSS.
	const zoom = pageZoom > 0 ? pageZoom : 1;
	const x = Math.round((gridCol * cell.cellWidthPx + cell.cellWidthPx / 2) / zoom);
	const y = Math.round((gridRow * cell.cellHeightPx + cell.cellHeightPx / 2) / zoom);
	return {
		x: Math.min(x, Math.round(layout.pageWidth / zoom) - 1),
		y: Math.min(y, Math.round(layout.pageHeight / zoom) - 1),
	};
}

/** Which toolbar row a pane-relative row falls on, or null if not the toolbar. */
export function toolbarRowAt(row: number, layout: ViewLayout): number | null {
	const idx = row - 1;
	if (idx < 0 || idx >= layout.toolbarRows) return null;
	return idx;
}
