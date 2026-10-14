/**
 * Rotate / crop / contrast preview for a receipt photo. The crop box can be dragged with a pointer or
 * adjusted with the arrow keys when a handle has focus (Shift = bigger steps).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { FULL_CROP, enhancedCopy, renderTransformed, type CropRect, type Rotation } from '../../ocr/image';

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'move';
const MIN = 0.08;

function clampRect(r: CropRect): CropRect {
  const w = Math.min(1, Math.max(MIN, r.w));
  const h = Math.min(1, Math.max(MIN, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

function adjust(r: CropRect, handle: Handle, dx: number, dy: number): CropRect {
  switch (handle) {
    case 'move':
      return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
    case 'nw': {
      const x = Math.min(r.x + r.w - MIN, Math.max(0, r.x + dx));
      const y = Math.min(r.y + r.h - MIN, Math.max(0, r.y + dy));
      return { x, y, w: r.x + r.w - x, h: r.y + r.h - y };
    }
    case 'ne': {
      const y = Math.min(r.y + r.h - MIN, Math.max(0, r.y + dy));
      return { x: r.x, y, w: Math.min(1 - r.x, Math.max(MIN, r.w + dx)), h: r.y + r.h - y };
    }
    case 'sw': {
      const x = Math.min(r.x + r.w - MIN, Math.max(0, r.x + dx));
      return { x, y: r.y, w: r.x + r.w - x, h: Math.min(1 - r.y, Math.max(MIN, r.h + dy)) };
    }
    case 'se':
      return { x: r.x, y: r.y, w: Math.min(1 - r.x, Math.max(MIN, r.w + dx)), h: Math.min(1 - r.y, Math.max(MIN, r.h + dy)) };
  }
}

export function ImageEditor(props: {
  image: ImageBitmap | HTMLImageElement;
  rotation: Rotation;
  crop: CropRect;
  enhance: boolean;
  onRotation: (r: Rotation) => void;
  onCrop: (c: CropRect) => void;
  onEnhance: (e: boolean) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string>('');
  const drag = useRef<{ handle: Handle; x: number; y: number; start: CropRect } | null>(null);

  useEffect(() => {
    const full = renderTransformed(props.image, props.rotation, FULL_CROP, 900);
    const shown = props.enhance ? enhancedCopy(full) : full;
    const url = shown.toDataURL('image/jpeg', 0.8);
    setPreview(url);
  }, [props.image, props.rotation, props.enhance]);

  const onDown = (handle: Handle) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: props.crop };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const area = canvasRef.current?.getBoundingClientRect();
    if (!d || !area) return;
    props.onCrop(adjust(d.start, d.handle, (e.clientX - d.x) / area.width, (e.clientY - d.y) / area.height));
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (handle: Handle) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = map[e.key];
    if (!m) return;
    e.preventDefault();
    props.onCrop(adjust(props.crop, handle, m[0], m[1]));
  };
  const c = props.crop;
  const rotate = (delta: 90 | -90) => {
    props.onRotation((((props.rotation + delta) % 360) + 360) % 360 as Rotation);
    props.onCrop(FULL_CROP);
  };

  return (
    <div className="editor">
      <div className="editor-stage" ref={canvasRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {preview && <img src={preview} alt="Receipt preview" className="editor-img" draggable={false} />}
        <div className="crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${c.y * 100}%, ${c.x * 100}% ${c.y * 100}%, ${c.x * 100}% ${(c.y + c.h) * 100}%, ${(c.x + c.w) * 100}% ${(c.y + c.h) * 100}%, ${(c.x + c.w) * 100}% ${c.y * 100}%, 0 ${c.y * 100}%)` }} />
        <div
          ref={boxRef}
          className="crop-box"
          style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
          onPointerDown={onDown('move')}
          tabIndex={0}
          role="group"
          aria-label="Crop area. Use arrow keys to move it."
          onKeyDown={onKey('move')}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <span key={h} className={`crop-handle ${h}`} onPointerDown={onDown(h)} tabIndex={0} role="button" aria-label={`Crop corner ${h}. Use arrow keys to resize.`} onKeyDown={onKey(h)} />
          ))}
        </div>
      </div>
      <div className="row gap wrap editor-tools">
        <button type="button" className="btn ghost small" onClick={() => rotate(-90)} aria-label="Rotate left">⟲ Rotate left</button>
        <button type="button" className="btn ghost small" onClick={() => rotate(90)} aria-label="Rotate right">⟳ Rotate right</button>
        <button type="button" className="btn ghost small" onClick={() => props.onCrop(FULL_CROP)}>Reset crop</button>
        <label className="check small"><input type="checkbox" checked={props.enhance} onChange={(e) => props.onEnhance(e.target.checked)} /> Improve contrast</label>
      </div>
    </div>
  );
}
