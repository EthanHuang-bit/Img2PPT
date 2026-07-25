export function boxArea(box) {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

export function intersects(a, b, padding = 0) {
  return !(
    a.x1 + padding < b.x0 ||
    b.x1 + padding < a.x0 ||
    a.y1 + padding < b.y0 ||
    b.y1 + padding < a.y0
  );
}

export function expandBox(box, padding, width, height) {
  return {
    x0: Math.max(0, box.x0 - padding),
    y0: Math.max(0, box.y0 - padding),
    x1: Math.min(width, box.x1 + padding),
    y1: Math.min(height, box.y1 + padding)
  };
}

export function mergeBoxes(boxes, maxGap = 5) {
  const pending = boxes.map((box) => ({ ...box }));
  const merged = [];
  while (pending.length) {
    let current = pending.shift();
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (intersects(current, pending[i], maxGap)) {
          current = {
            x0: Math.min(current.x0, pending[i].x0),
            y0: Math.min(current.y0, pending[i].y0),
            x1: Math.max(current.x1, pending[i].x1),
            y1: Math.max(current.y1, pending[i].y1)
          };
          pending.splice(i, 1);
          changed = true;
        }
      }
    }
    merged.push(current);
  }
  return merged;
}

