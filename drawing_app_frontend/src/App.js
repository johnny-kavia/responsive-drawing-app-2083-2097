import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Drawing model:
 * - We keep a stack of snapshots (ImageData) for undo/redo.
 * - We render background image onto an offscreen canvas, then draw strokes onto main.
 * - Zoom/pan are view transforms only (do not change drawing resolution).
 */

const THEME = {
  primary: "#3B82F6",
  secondary: "#10B981",
  success: "#F59E0B",
  error: "#EF4444",
  background: "#f9fafb",
  surface: "#ffffff",
  text: "#111827",
  border: "rgba(17,24,39,0.12)",
};

const TOOL = {
  BRUSH: "brush",
  ERASER: "eraser",
  PAN: "pan",
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }, [query]);
  return matches;
}

// PUBLIC_INTERFACE
function App() {
  /** Main application component providing the drawing UI and canvas feature set. */
  const isMobile = useMediaQuery("(max-width: 860px)");

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const bgCanvasRef = useRef(null); // offscreen for background
  const dprRef = useRef(1);

  const [tool, setTool] = useState(TOOL.BRUSH);
  const [color, setColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(8);

  // View transform
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // History
  const [history, setHistory] = useState([]); // array of ImageData
  const [historyIndex, setHistoryIndex] = useState(-1);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

  const [isDrawing, setIsDrawing] = useState(false);
  const lastPointRef = useRef(null);
  const pointerIdRef = useRef(null);

  // Pan drag state
  const panStartRef = useRef(null);

  const exportFilename = useMemo(() => {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    return `drawing-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours(),
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  }, []);

  function getCtx() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.getContext("2d", { willReadFrequently: true });
  }

  function getBgCtx() {
    const c = bgCanvasRef.current;
    if (!c) return null;
    return c.getContext("2d", { willReadFrequently: true });
  }

  function getCanvasSize() {
    const canvas = canvasRef.current;
    if (!canvas) return { w: 0, h: 0 };
    return { w: canvas.width, h: canvas.height };
  }

  function clientToCanvasPoint(clientX, clientY) {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    // Convert to CSS pixel coords within canvas element
    const xCss = clientX - rect.left;
    const yCss = clientY - rect.top;

    // Convert view transform (pan/zoom) to logical drawing coordinates (CSS px space)
    const xLogical = (xCss - pan.x) / zoom;
    const yLogical = (yCss - pan.y) / zoom;

    // Convert logical CSS space to actual canvas pixel space
    const dpr = dprRef.current || 1;
    return { x: xLogical * dpr, y: yLogical * dpr };
  }

  function pushHistorySnapshot() {
    const ctx = getCtx();
    if (!ctx) return;
    const { w, h } = getCanvasSize();
    if (!w || !h) return;

    const snapshot = ctx.getImageData(0, 0, w, h);
    setHistory((prev) => {
      // If we undid, discard "future" states.
      const next = prev.slice(0, historyIndex + 1);
      next.push(snapshot);
      return next;
    });
    setHistoryIndex((prev) => prev + 1);
  }

  function applySnapshot(index) {
    const ctx = getCtx();
    if (!ctx) return;
    const snap = history[index];
    if (!snap) return;
    ctx.putImageData(snap, 0, 0);
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function clearCanvas() {
    const ctx = getCtx();
    const bgCtx = getBgCtx();
    if (!ctx || !bgCtx) return;
    const { w, h } = getCanvasSize();
    if (!w || !h) return;

    // clear both drawing and bg
    bgCtx.clearRect(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);

    // Fill with white surface so exported png is not transparent unless background imported
    ctx.save();
    ctx.fillStyle = THEME.surface;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    pushHistorySnapshot();
    resetView();
  }

  function redrawFromBgAndSnapshotDrawing(drawingSnap) {
    const ctx = getCtx();
    const bgCtx = getBgCtx();
    if (!ctx || !bgCtx) return;
    const { w, h } = getCanvasSize();
    if (!w || !h) return;

    // Start with background
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = THEME.surface;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.drawImage(bgCanvasRef.current, 0, 0);

    // Apply drawing snapshot if provided
    if (drawingSnap) ctx.putImageData(drawingSnap, 0, 0);
  }

  function resizeCanvasesToContainer() {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const bgCanvas = bgCanvasRef.current;
    if (!container || !canvas || !bgCanvas) return;

    const rect = container.getBoundingClientRect();
    const wCss = Math.max(300, Math.floor(rect.width));
    const hCss = Math.max(280, Math.floor(rect.height));

    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;

    const w = Math.floor(wCss * dpr);
    const h = Math.floor(hCss * dpr);

    // Preserve current drawing by snapshotting before resize
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const prev = ctx.getImageData(0, 0, canvas.width || 1, canvas.height || 1);

    const bgCtx = bgCanvas.getContext("2d", { willReadFrequently: true });
    const prevBg = bgCtx.getImageData(0, 0, bgCanvas.width || 1, bgCanvas.height || 1);

    canvas.width = w;
    canvas.height = h;
    bgCanvas.width = w;
    bgCanvas.height = h;

    canvas.style.width = `${wCss}px`;
    canvas.style.height = `${hCss}px`;

    // Restore previous content scaled if sizes changed.
    // Simplest: draw previous image data via temp canvas.
    const tmp = document.createElement("canvas");
    tmp.width = prev.width;
    tmp.height = prev.height;
    tmp.getContext("2d").putImageData(prev, 0, 0);

    const tmpBg = document.createElement("canvas");
    tmpBg.width = prevBg.width;
    tmpBg.height = prevBg.height;
    tmpBg.getContext("2d").putImageData(prevBg, 0, 0);

    // Background restore
    bgCtx.clearRect(0, 0, w, h);
    bgCtx.drawImage(tmpBg, 0, 0, prevBg.width, prevBg.height, 0, 0, w, h);

    // Drawing restore
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = THEME.surface;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.drawImage(tmp, 0, 0, prev.width, prev.height, 0, 0, w, h);

    // When resizing, treat as new history base to avoid mismatch sizes.
    const snap = ctx.getImageData(0, 0, w, h);
    setHistory([snap]);
    setHistoryIndex(0);
  }

  function initCanvasOnce() {
    const canvas = canvasRef.current;
    const bgCanvas = bgCanvasRef.current;
    if (!canvas || !bgCanvas) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const bgCtx = bgCanvas.getContext("2d", { willReadFrequently: true });
    bgCtx.imageSmoothingEnabled = true;

    // initial fill
    resizeCanvasesToContainer();
    // ensure we have a white base if history is empty
    if (historyIndex < 0) {
      const { w, h } = getCanvasSize();
      ctx.save();
      ctx.fillStyle = THEME.surface;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      setHistory([ctx.getImageData(0, 0, w, h)]);
      setHistoryIndex(0);
    }
  }

  useEffect(() => {
    initCanvasOnce();
    // Resize observer for responsive behavior
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => resizeCanvasesToContainer());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply history snapshots when index changes (undo/redo)
  useEffect(() => {
    if (historyIndex < 0) return;
    applySnapshot(historyIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyIndex]);

  function drawLine(from, to, modeTool) {
    const ctx = getCtx();
    if (!ctx) return;

    const dpr = dprRef.current || 1;

    ctx.save();
    ctx.globalCompositeOperation = modeTool === TOOL.ERASER ? "destination-out" : "source-over";
    ctx.strokeStyle = modeTool === TOOL.ERASER ? "rgba(0,0,0,1)" : color;
    ctx.lineWidth = brushSize * dpr;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function onPointerDown(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // capture pointer for consistent draw
    pointerIdRef.current = e.pointerId;
    canvas.setPointerCapture?.(e.pointerId);

    if (tool === TOOL.PAN || (e.button === 1 && !isMobile)) {
      // Middle mouse or explicit pan tool
      panStartRef.current = {
        startPan: { ...pan },
        startClient: { x: e.clientX, y: e.clientY },
      };
      return;
    }

    setIsDrawing(true);
    const p = clientToCanvasPoint(e.clientX, e.clientY);
    lastPointRef.current = p;

    // dot
    drawLine(p, { x: p.x + 0.01, y: p.y + 0.01 }, tool);
  }

  function onPointerMove(e) {
    if (tool === TOOL.PAN) {
      if (!panStartRef.current) return;
      const dx = e.clientX - panStartRef.current.startClient.x;
      const dy = e.clientY - panStartRef.current.startClient.y;
      setPan({ x: panStartRef.current.startPan.x + dx, y: panStartRef.current.startPan.y + dy });
      return;
    }

    if (!isDrawing) return;
    if (pointerIdRef.current != null && e.pointerId !== pointerIdRef.current) return;

    const curr = clientToCanvasPoint(e.clientX, e.clientY);
    const last = lastPointRef.current;
    if (!last) {
      lastPointRef.current = curr;
      return;
    }
    drawLine(last, curr, tool);
    lastPointRef.current = curr;
  }

  function endDrawingOrPanning() {
    if (panStartRef.current) {
      panStartRef.current = null;
      return;
    }
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPointRef.current = null;
    pointerIdRef.current = null;
    pushHistorySnapshot();
  }

  function onWheel(e) {
    // ctrl+wheel often for browser zoom; we treat plain wheel as zoom (trackpads too)
    e.preventDefault();

    const zoomFactor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const nextZoom = clamp(zoom * zoomFactor, 0.25, 4);

    // zoom around mouse position
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newPanX = x - ((x - pan.x) / zoom) * nextZoom;
    const newPanY = y - ((y - pan.y) / zoom) * nextZoom;

    setZoom(nextZoom);
    setPan({ x: newPanX, y: newPanY });
  }

  function undo() {
    if (!canUndo) return;
    setHistoryIndex((i) => i - 1);
  }

  function redo() {
    if (!canRedo) return;
    setHistoryIndex((i) => i + 1);
  }

  function exportPNG() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Export exact canvas pixels
    const a = document.createElement("a");
    a.download = exportFilename;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }

  async function importBackgroundFromFile(file) {
    const bgCtx = getBgCtx();
    const ctx = getCtx();
    if (!bgCtx || !ctx) return;
    if (!file) return;

    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const { w, h } = getCanvasSize();
      // Draw into bg offscreen, fitting image inside canvas while preserving aspect ratio
      bgCtx.clearRect(0, 0, w, h);

      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;

      bgCtx.drawImage(img, dx, dy, dw, dh);

      // Then composite bg under current drawing by re-drawing current snapshot
      const current = historyIndex >= 0 ? history[historyIndex] : null;
      if (current) {
        // current already includes bg from last render, so we rebuild: white + bg + current strokes
        // To approximate "strokes only" we just draw bg, then draw current on top; it’s acceptable for this scope.
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = THEME.surface;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        ctx.drawImage(bgCanvasRef.current, 0, 0);
        ctx.putImageData(current, 0, 0);
      } else {
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = THEME.surface;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        ctx.drawImage(bgCanvasRef.current, 0, 0);
      }

      pushHistorySnapshot();
      URL.revokeObjectURL(imgUrl);
    };
    img.onerror = () => URL.revokeObjectURL(imgUrl);
    img.src = imgUrl;
  }

  function onImportInputChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    importBackgroundFromFile(file);
    // allow re-import same file
    e.target.value = "";
  }

  const canvasStyle = useMemo(
    () => ({
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      transformOrigin: "0 0",
      touchAction: "none",
      cursor:
        tool === TOOL.PAN
          ? "grab"
          : tool === TOOL.ERASER
            ? "cell"
            : "crosshair",
    }),
    [pan.x, pan.y, zoom, tool],
  );

  const ToolButton = ({ active, onClick, children, title }) => {
    return (
      <button
        className={`btn toolBtn ${active ? "active" : ""}`}
        onClick={onClick}
        type="button"
        title={title}
      >
        {children}
      </button>
    );
  };

  return (
    <div className="appRoot" style={{ background: THEME.background, color: THEME.text }}>
      <header className="appHeader">
        <div className="headerLeft">
          <div className="appTitle">Drawing App</div>
          <div className="appSubtitle">Brush • Eraser • Undo/Redo • Import • Export • Zoom/Pan</div>
        </div>

        <div className="headerRight">
          <label className="btn subtle fileBtn" title="Import an image as background">
            Import
            <input
              type="file"
              accept="image/*"
              onChange={onImportInputChange}
              style={{ display: "none" }}
            />
          </label>

          <button className="btn primary" onClick={exportPNG} type="button" title="Export as PNG">
            Export PNG
          </button>
        </div>
      </header>

      <div className={`mainLayout ${isMobile ? "mobile" : ""}`}>
        <aside className="toolRail" aria-label="Tools">
          <div className="toolRailTitle">Tools</div>
          <div className="toolGrid">
            <ToolButton
              active={tool === TOOL.BRUSH}
              onClick={() => setTool(TOOL.BRUSH)}
              title="Brush"
            >
              Brush
            </ToolButton>
            <ToolButton
              active={tool === TOOL.ERASER}
              onClick={() => setTool(TOOL.ERASER)}
              title="Eraser"
            >
              Eraser
            </ToolButton>
            <ToolButton
              active={tool === TOOL.PAN}
              onClick={() => setTool(TOOL.PAN)}
              title="Pan (drag to move view)"
            >
              Pan
            </ToolButton>

            <button className="btn toolBtn" onClick={resetView} type="button" title="Reset zoom/pan">
              Reset View
            </button>
          </div>

          <div className="toolHint">
            <div className="hintLine">
              <b>Zoom</b>: mouse wheel / trackpad
            </div>
            <div className="hintLine">
              <b>Pan</b>: use Pan tool (or middle mouse)
            </div>
          </div>
        </aside>

        <main className="canvasStage" aria-label="Canvas area">
          <div className="canvasShell">
            <div className="canvasFrame" ref={containerRef}>
              {/* offscreen background canvas */}
              <canvas ref={bgCanvasRef} style={{ display: "none" }} />

              <canvas
                ref={canvasRef}
                className="drawingCanvas"
                style={canvasStyle}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrawingOrPanning}
                onPointerCancel={endDrawingOrPanning}
                onPointerLeave={() => {
                  // If pointer leaves without up, still end drawing to save history
                  if (isDrawing) endDrawingOrPanning();
                }}
                onWheel={onWheel}
                role="img"
                aria-label="Drawing canvas"
              />
            </div>
          </div>
        </main>
      </div>

      <footer className="footerPanel" aria-label="Options">
        <div className="footerGroup">
          <label className="field">
            <div className="fieldLabel">Brush size</div>
            <input
              type="range"
              min={1}
              max={64}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
            <div className="fieldValue">{brushSize}px</div>
          </label>

          <label className="field">
            <div className="fieldLabel">Color</div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              disabled={tool === TOOL.ERASER}
              title={tool === TOOL.ERASER ? "Color disabled in Eraser mode" : "Pick brush color"}
            />
          </label>

          <div className="field compact">
            <div className="fieldLabel">Zoom</div>
            <div className="zoomReadout">{Math.round(zoom * 100)}%</div>
          </div>
        </div>

        <div className="footerGroup actions">
          <button className="btn subtle" onClick={undo} type="button" disabled={!canUndo} title="Undo">
            Undo
          </button>
          <button className="btn subtle" onClick={redo} type="button" disabled={!canRedo} title="Redo">
            Redo
          </button>
          <button className="btn danger" onClick={clearCanvas} type="button" title="Clear canvas">
            Clear
          </button>
        </div>
      </footer>
    </div>
  );
}
