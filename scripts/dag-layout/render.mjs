const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function renderDagSvg({ input, geometry: g, labels }, title) {
  const paths = Object.values(g.routes).flat();
  const minX = Math.min(0, ...paths.map((p) => p.x)), minY = Math.min(0, ...paths.map((p) => p.y));
  const width = Math.max(g.width, ...paths.map((p) => p.x)) - minX + 40;
  const height = Math.max(g.height, ...paths.map((p) => p.y)) - minY + 100;
  const elements = [];
  let nextLabel = 0;
  const text = (id, box, frame = false) => {
    const label = labels[id] ?? id;
    let used = 0;
    const lines = [""];
    for (const character of label) {
      const advance = character.codePointAt(0) > 0x2e80 ? 13 : 7.3;
      if (used + advance > box.width - 28) { lines.push(""); used = 0; }
      lines[lines.length - 1] += character; used += advance;
    }
    const limit = frame ? 2 : 3, visible = lines.slice(0, limit);
    if (lines.length > limit) visible[limit - 1] = visible[limit - 1].slice(0, -1) + "…";
    const clip = `label-${nextLabel++}`;
    return `<clipPath id="${clip}"><rect x="${box.x + 10}" y="${box.y}" width="${box.width - 20}" height="${box.height}"/></clipPath><g clip-path="url(#${clip})">` + visible.map((line, i) => `<text x="${box.x + 14}" y="${box.y + 24 + i * 19}" font-size="13">${xml(line)}</text>`).join("") + "</g>";
  };
  for (const frame of input.frames) {
    const box = g.frames[frame.id]; if (!box) continue;
    elements.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="#f6f8fc" fill-opacity="0.6" stroke="#a3afc4"/>`, text(frame.id, box, true));
    for (const band of box.bands) {
      elements.push(`<line x1="${box.x + band.start}" x2="${box.x + band.start}" y1="${box.y + 76}" y2="${box.y + box.height}" stroke="#d8e0ec"/>`, `<text x="${box.x + band.start + 12}" y="${box.y + 94}" font-size="12" fill="#69768b">Stage ${band.stage}</text>`);
    }
  }
  for (const segment of g.segments) elements.push(`<path d="M${segment.start.x},${segment.start.y} L${segment.end.x},${segment.end.y}" fill="none" stroke="#59687d" stroke-width="${segment.edgeIds.length > 1 ? 2 : 1.3}"/>`);
  for (const point of g.junctions) elements.push(`<circle cx="${point.x}" cy="${point.y}" r="3" fill="#45566e"/>`);
  for (const node of input.nodes) {
    const box = g.nodes[node.id]; if (!box) continue;
    elements.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="6" fill="white" stroke="${input.kind === "focus" && node.side === "current" ? "#5266dd" : "#c5cede"}" ${node.side && input.kind === "line" ? 'stroke-dasharray="5 4"' : ""}/>`, text(node.id, box));
    const ports = g.ports[node.id];
    if (ports) for (const p of Object.values(ports)) elements.push(`<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="#8a9ab0"/>`);
  }
  for (const path of Object.values(g.routes)) {
    const end = path.at(-1), before = path.at(-2); if (!end || !before) continue;
    const angle = Math.atan2(end.y - before.y, end.x - before.x) * 180 / Math.PI;
    elements.push(`<path d="M-7,-3 L0,0 L-7,3" fill="none" stroke="#59687d" transform="translate(${end.x},${end.y}) rotate(${angle})"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX - 20} ${minY - 70} ${width} ${height}"><rect x="${minX - 20}" y="${minY - 70}" width="${width}" height="${height}" fill="#fff"/><g font-family="Arial,Noto Sans CJK SC,sans-serif" fill="#26334a"><text x="${minX}" y="${minY - 40}" font-size="21" font-weight="bold">${xml(title)} · ${g.quality} · ${input.nodes.length} cards / ${input.edges.length} edges</text>${elements.join("")}</g></svg>`;
}
